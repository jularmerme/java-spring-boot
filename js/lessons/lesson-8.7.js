LESSONS['8.7']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** In lessons 7.1-7.3 you built the TaskFlow capstone: package ^com.example.taskflow^, entities **User**, **Project** and **Task**, stateless JWT security, PostgreSQL with Flyway migrations, and a Docker Compose stack for the app and the database. Every request today is handled by a classic Spring MVC controller running on Tomcat. In this lesson we add **virtual threads**, an **async report generation** endpoint, **scheduled jobs**, and a **reactive Server-Sent Events stream** for live task updates. New files: ^AsyncConfig^, ^ReportService^, ^ReportController^, ^ReportJob^ record, ^OverdueTaskScheduler^, ^TaskEventPublisher^, ^TaskStreamController^, ^TaskEvent^ record. Changed files: ^pom.xml^, ^application.yml^, ^TaskService^.

### 1.1 The servlet thread-per-request model

When an HTTP request reaches Tomcat, an **acceptor** takes the TCP connection, a **poller** notices bytes are ready, and a **worker thread** from Tomcat's pool (default max 200) runs the whole request: filters, Spring Security's filter chain, the ^DispatcherServlet^, your controller, your service, the JDBC call to PostgreSQL, JSON serialization of the response. That one thread is "owned" by the request from start to finish. This is the **thread-per-request** model.

Real-world analogy: a restaurant where every guest gets a dedicated waiter for the whole meal. While the kitchen (the database) cooks, the waiter stands next to the table doing nothing. With 200 waiters you can serve at most 200 tables at once, even if 190 of those waiters are just waiting.

That waiting is the core problem. A typical TaskFlow request spends maybe 1 ms of CPU and 20-200 ms **blocked** on I/O (database, a call to another service, an email provider). A platform thread (a real OS thread) costs roughly 1 MB of reserved stack plus kernel scheduling overhead, so you cannot simply set ^server.tomcat.threads.max^ to 50,000.

| Symptom under load | Root cause |
|---|---|
| Latency spikes while CPU is at 15% | All worker threads blocked on I/O, new requests queue |
| "Connection refused" or timeouts at the load balancer | Tomcat accept queue full |
| Thread dump shows 200 threads in SocketInputStream.read | Slow downstream service holds threads hostage |
| Memory grows with thread count | Each platform thread reserves its own stack |

There were historically two escape routes: **reactive programming** (never block a thread; use a few event-loop threads and callbacks) and, since Java 21, **virtual threads** (make threads so cheap that blocking no longer matters).

### 1.2 Java 21 virtual threads

A **virtual thread** is a ^java.lang.Thread^ managed by the JVM, not the OS. The JVM runs many virtual threads on a small pool of **carrier threads** (a ForkJoinPool sized to your CPU cores). When a virtual thread performs blocking I/O, the JVM **unmounts** it: it saves its stack to the heap and frees the carrier to run another virtual thread. When the I/O completes, the virtual thread is **mounted** again, possibly on a different carrier.

Under the hood: the JDK's blocking APIs (sockets, ^Thread.sleep^, ^java.util.concurrent^ locks) were rewritten to detect "I am on a virtual thread" and park instead of blocking the carrier. Your code keeps its simple, sequential, debuggable style, and you can have hundreds of thousands of concurrent virtual threads.

In Spring Boot 3.2+ you switch the whole application over with one property:

~~~properties src/main/resources/application.properties (equivalent)
spring.threads.virtual.enabled=true
~~~

What Spring Boot actually does when this property is true:

| Component | Without virtual threads | With spring.threads.virtual.enabled=true |
|---|---|---|
| Tomcat request handling | Platform worker pool (max 200) | A new virtual thread per request |
| @Async default executor | ThreadPoolTaskExecutor (8 core threads) | SimpleAsyncTaskExecutor using virtual threads |
| @Scheduled | ThreadPoolTaskScheduler (1 thread) | SimpleAsyncTaskScheduler using virtual threads |
| Kafka/RabbitMQ listeners | Platform listener threads | Virtual threads (where supported) |
| Blocking JDBC call | Blocks an OS thread | Parks the virtual thread, carrier is freed |

Important: the auto-configured ^@Async^ executor only switches to virtual threads if **you have not defined your own** ^TaskExecutor^ bean. If you define one (as we will), you decide.

### 1.3 Caveats: pinning, synchronized and ThreadLocal

**Pinning.** A virtual thread is *pinned* to its carrier when it blocks inside a ^synchronized^ block or method, or inside native code. While pinned, the carrier cannot run other virtual threads. A few pinned threads are harmless; hundreds of them can starve your 8 carriers and the application looks frozen. JDK 24 (JEP 491) removes pinning for ^synchronized^ in most cases, but on Java 21 you should prefer ^ReentrantLock^ around blocking code in your own classes. Detect pinning with ^-Djdk.tracePinnedThreads=full^ (Java 21-23) or JFR's ^jdk.VirtualThreadPinned^ event.

**ThreadLocal.** Virtual threads support ^ThreadLocal^, but there may be a million of them. Caching an expensive object (a ^SimpleDateFormat^, a big buffer) in a ThreadLocal used to be "one per pooled thread"; now it is "one per request" and the cache is useless or even a memory leak. Security context and MDC still work because Spring sets and clears them per request.

**Do not pool virtual threads.** They are cheap; pooling them defeats the purpose. To limit concurrency to a scarce resource, use a ^Semaphore^, not a fixed pool.

**Connection pool sizing still matters.** Virtual threads remove the Tomcat limit of 200, so now 5,000 requests can hit your service layer simultaneously. HikariCP still has (by default) **10** connections. 4,990 virtual threads will wait for a connection, and if they wait longer than ^connectionTimeout^ (30 s) they fail. The database is the real bottleneck: PostgreSQL itself handles a few hundred connections at best. Size the pool from the database's capacity (a common starting formula is cores times 2 plus effective spindles, often 10-30), not from the number of threads, and set a sensible timeout so overload fails fast.

> Virtual threads make **waiting** cheap. They do not make **CPU work** faster, and they do not create more database capacity.

### 1.4 @Async and CompletableFuture

^@Async^ tells Spring: "call this method on another thread and return to the caller immediately". Under the hood, ^@EnableAsync^ registers a bean post-processor that wraps your bean in a **proxy** (the same AOP mechanism as ^@Transactional^, lesson 3.3). When code calls the proxy, the proxy submits the real invocation to a ^TaskExecutor^ and returns a ^CompletableFuture^ (or nothing, for ^void^ methods).

Consequences of the proxy mechanism:

- Calling an ^@Async^ method from **the same class** (self-invocation) bypasses the proxy and runs synchronously.
- The method must be public and the bean must be Spring-managed.
- Exceptions in ^void^ async methods are lost unless you configure an ^AsyncUncaughtExceptionHandler^; with ^CompletableFuture^ the exception completes the future exceptionally.
- The ^SecurityContext^ is thread-bound and does **not** follow the call by default. Wrap the executor with ^DelegatingSecurityContextAsyncTaskExecutor^ if the async code needs the current user, or (better) pass the user id as a parameter.
- A transaction does not cross threads. The async method needs its own ^@Transactional^.

### 1.5 @Scheduled: fixedRate, fixedDelay, cron

^@EnableScheduling^ registers a post-processor that finds ^@Scheduled^ methods and registers them with a ^TaskScheduler^.

| Attribute | Meaning | Example use |
|---|---|---|
| fixedRate = 60000 | Start every 60 s, measured start-to-start | Metrics sampling |
| fixedDelay = 60000 | Wait 60 s after the previous run **finished** | Polling a queue, avoids overlap |
| initialDelay = 10000 | Wait before first run | Let the app warm up |
| cron = "0 0 7 * * MON-FRI" | Spring 6-field cron: sec min hour day month weekday | Daily 07:00 overdue digest |
| zone = "Europe/Berlin" | Time zone for cron | Avoid UTC surprises |

Durations may also be written as ISO or simple strings with ^timeUnit^ or values like ^fixedRateString = "PT1M"^, and placeholders such as ^§{taskflow.scheduler.cron}^ keep schedules configurable.

**The multi-instance duplicate problem.** In lesson 8.8 TaskFlow will run as 3 Kubernetes replicas. Each replica has its own scheduler, so your 07:00 digest email is sent **three times**. Solutions: a distributed lock such as **ShedLock** (a tiny table ^shedlock^ in PostgreSQL; the first instance to grab the lock runs the job, others skip), a dedicated single "worker" deployment, a Kubernetes **CronJob**, or a proper job framework (Quartz cluster mode, JobRunr). For TaskFlow, ShedLock with the JDBC provider and a Flyway migration for its table is the pragmatic choice; we mention it here and you will add it in Exercise 2.

### 1.6 Thread safety of singleton beans (callback to lesson 1.1)

Remember lesson 1.1: Spring beans are **singletons** by default. One ^TaskService^ instance serves every request. Before this lesson that already meant up to 200 concurrent threads; now, with virtual threads, async methods and schedulers, it can be thousands. A structured way to think about it:

1. **Stateless beans are safe.** Fields that are only injected dependencies (final, set in the constructor) are fine.
2. **Immutable state is safe.** Records, ^List.of^, final config values.
3. **Mutable shared state must be protected** or replaced: use ^ConcurrentHashMap^, ^AtomicLong^, ^ReentrantLock^, or move the state to the database.
4. **Request state belongs in parameters/locals**, never in a field. A field ^currentUser^ on a service is a classic data leak between users.
5. **Know which thread runs your code.** Async, scheduler, reactive and request threads have different security, transaction and MDC contexts.

### 1.7 Reactive programming: Project Reactor

Reactive Spring (WebFlux) is built on **Project Reactor**, an implementation of the Reactive Streams specification. Two types:

| Type | Emits | Analogy |
|---|---|---|
| Mono of T | 0 or 1 item, then complete or error | A promise for one result |
| Flux of T | 0..N items, then complete or error | A stream / conveyor belt |

Nothing happens until someone **subscribes** ("nothing happens until you subscribe"). A pipeline is a recipe; WebFlux subscribes for you when it writes the HTTP response.

Common operators:

| Operator | Purpose |
|---|---|
| map | Transform each item synchronously |
| flatMap | Transform each item into another Mono/Flux (async), merged |
| concatMap | Like flatMap but preserves order, one at a time |
| filter | Drop items |
| zip | Combine results of several publishers |
| switchIfEmpty / defaultIfEmpty | Fallback when nothing is emitted |
| onErrorResume / onErrorReturn | Error handling |
| timeout / retryWhen | Resilience |
| buffer / window / sample | Batching and rate shaping |

**Backpressure** is the subscriber's ability to tell the publisher "I can only take N more items" (^request(n)^). If the database produces 1 million rows but the HTTP client reads slowly, backpressure prevents the server from loading everything into memory. For hot sources you cannot slow down (user clicks, events), you choose a strategy: buffer, drop, keep latest, or error (^onBackpressureBuffer^, ^onBackpressureDrop^, ^onBackpressureLatest^).

Under the hood, WebFlux runs on **Netty** with a small number of **event-loop** threads (about one per core). One event-loop thread multiplexes thousands of connections. This only works if **nobody ever blocks** an event-loop thread.

### 1.8 Why you cannot mix blocking JDBC into a reactive pipeline

JDBC, JPA and Hibernate are **blocking** by design: ^findById^ holds the calling thread until PostgreSQL answers. On Netty with 8 event-loop threads, 8 slow queries freeze the entire server. Wrapping the call in ^Mono.fromCallable(...)^ does not help on its own; you would have to move it to ^Schedulers.boundedElastic()^, which just recreates a thread pool, and the JPA transaction and lazy loading still assume one thread. For a fully reactive stack you need **R2DBC** (Reactive Relational Database Connectivity) with ^spring-boot-starter-data-r2dbc^ and the ^r2dbc-postgresql^ driver: repositories return ^Mono^ and ^Flux^, there is no lazy loading, no JPA relationships, and Flyway still needs a JDBC connection for migrations. Detect accidental blocking with **BlockHound** in tests.

### 1.9 Decision guide: MVC + virtual threads vs WebFlux

| Question | MVC + virtual threads | WebFlux |
|---|---|---|
| Existing JPA/JDBC code? | Keep it as is | Rewrite to R2DBC |
| Team experience | Plain imperative Java | Needs reactive skills |
| Debugging and stack traces | Normal | Harder, needs checkpoint/log operators |
| High concurrency with blocking I/O | Excellent | Excellent |
| Streaming, backpressure, SSE, WebSockets at scale | Possible (SseEmitter) | Natural fit |
| Gateway / proxy with many outgoing calls | Good | Excellent |
| CPU-bound workloads | Neither helps; add cores | Neither helps |

**Recommendation for TaskFlow (and most business apps in 2026):** stay on Spring MVC, enable virtual threads, use ^WebClient^ or ^RestClient^ for outgoing calls, and use Reactor selectively for streaming. Spring Boot lets you include both ^spring-boot-starter-web^ and ^spring-boot-starter-webflux^: the app stays a **servlet** app on Tomcat, but you can return ^Flux^ from MVC controllers and use ^WebClient^. That is exactly what we will do for the SSE endpoint.

## 2. Code Walkthrough

### Step 1: Dependencies

We add WebFlux (for Reactor, ^Flux^ return types and ^WebClient^) alongside the web starter. Because both are present, Spring Boot keeps the servlet stack.

~~~xml pom.xml (dependencies section, changed)
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <!-- NEW: Reactor, Flux/Mono return types in MVC, WebClient. App stays on Tomcat. -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-security</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
        <groupId>org.flywaydb</groupId>
        <artifactId>flyway-core</artifactId>
    </dependency>
    <dependency>
        <groupId>org.flywaydb</groupId>
        <artifactId>flyway-database-postgresql</artifactId>
    </dependency>
    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
        <scope>runtime</scope>
    </dependency>
    <dependency>
        <groupId>io.projectreactor</groupId>
        <artifactId>reactor-test</artifactId>
        <scope>test</scope>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-test</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
~~~

### Step 2: Enable virtual threads and tune the pool

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: taskflow
  threads:
    virtual:
      enabled: true          # Tomcat, @Scheduled and default executors use virtual threads
  datasource:
    url: jdbc:postgresql://§{DB_HOST:localhost}:5432/taskflow
    username: §{DB_USER:taskflow}
    password: §{DB_PASSWORD:secret}
    hikari:
      maximum-pool-size: 20  # sized for the DATABASE, not for the number of threads
      connection-timeout: 3000   # fail fast (3 s) instead of piling up waiters
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
  lifecycle:
    timeout-per-shutdown-phase: 30s

server:
  shutdown: graceful

taskflow:
  reports:
    max-concurrent: 4        # protect the DB from too many heavy report queries
  scheduler:
    overdue-cron: "0 0 7 * * MON-FRI"
    zone: "Europe/Berlin"

logging:
  pattern:
    level: "%5p [%thread]"   # shows the thread name, useful to SEE virtual threads
~~~

Start the app with ^./mvnw spring-boot:run^ (PowerShell: ^.\mvnw spring-boot:run^) and hit any endpoint. Virtual threads have no name by default, so the log shows an empty thread name or something like ^tomcat-handler-12^ depending on the version. A quick sanity check is a tiny diagnostics endpoint you can delete afterwards:

~~~java src/main/java/com/example/taskflow/controller/DiagnosticsController.java
package com.example.taskflow.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/diagnostics")
public class DiagnosticsController {

    @GetMapping("/thread")
    public Map<String, Object> thread() {
        Thread t = Thread.currentThread();
        return Map.of(
                "name", t.getName(),
                "virtual", t.isVirtual(),
                "string", t.toString());
    }
}
~~~

~~~text Expected output (GET /api/diagnostics/thread with a valid JWT)
{"name":"tomcat-handler-3","virtual":true,"string":"VirtualThread[#61,tomcat-handler-3]/runnable@ForkJoinPool-1-worker-2"}
~~~

Notice ^ForkJoinPool-1-worker-2^: that is the **carrier** thread currently running the virtual thread.

### Step 3: A configured TaskExecutor for @Async

We deliberately define our own executor for report generation. It uses virtual threads but **limits concurrency** with a ^SimpleAsyncTaskExecutor^ concurrency limit, because each report runs a heavy query. We also propagate MDC and the security context, and handle uncaught exceptions.

~~~java src/main/java/com/example/taskflow/config/AsyncConfig.java
package com.example.taskflow.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.aop.interceptor.AsyncUncaughtExceptionHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.core.task.TaskDecorator;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.security.task.DelegatingSecurityContextAsyncTaskExecutor;

import java.util.Map;
import java.util.concurrent.Executor;

@Configuration
@EnableAsync
@EnableScheduling
public class AsyncConfig implements AsyncConfigurer {

    private static final Logger log = LoggerFactory.getLogger(AsyncConfig.class);

    private final int maxConcurrentReports;

    public AsyncConfig(@Value("§{taskflow.reports.max-concurrent:4}") int maxConcurrentReports) {
        this.maxConcurrentReports = maxConcurrentReports;
    }

    /** Executor used by @Async("reportExecutor"). Virtual threads + a concurrency limit. */
    @Bean(name = "reportExecutor")
    public Executor reportExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("report-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(maxConcurrentReports); // acts like a semaphore
        executor.setTaskDecorator(mdcPropagatingDecorator());
        // Copies the caller's SecurityContext onto the async thread
        return new DelegatingSecurityContextAsyncTaskExecutor(executor);
    }

    /** Default executor for plain @Async without a qualifier. */
    @Override
    public Executor getAsyncExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("async-");
        executor.setVirtualThreads(true);
        executor.setTaskDecorator(mdcPropagatingDecorator());
        return executor;
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) ->
                log.error("Async method {} failed", method.getName(), ex);
    }

    private TaskDecorator mdcPropagatingDecorator() {
        return runnable -> {
            Map<String, String> context = MDC.getCopyOfContextMap();
            return () -> {
                if (context != null) {
                    MDC.setContextMap(context);
                }
                try {
                    runnable.run();
                } finally {
                    MDC.clear();
                }
            };
        };
    }
}
~~~

Why ^setConcurrencyLimit^ instead of a fixed thread pool? With virtual threads we do not pool; we **throttle**. Extra tasks block (cheaply) until a slot frees up.

### Step 4: Async report generation

The flow: the client POSTs a report request, gets **202 Accepted** with a ^Location^ header immediately, and polls the job status. This is the standard asynchronous request-reply pattern; it keeps HTTP requests short and survives slow reports.

~~~java src/main/java/com/example/taskflow/dto/ReportJob.java
package com.example.taskflow.dto;

import java.time.Instant;
import java.util.UUID;

public record ReportJob(
        UUID id,
        Long projectId,
        Status status,
        Instant createdAt,
        Instant finishedAt,
        ProjectReport result,
        String error) {

    public enum Status { PENDING, RUNNING, DONE, FAILED }

    public static ReportJob pending(UUID id, Long projectId) {
        return new ReportJob(id, projectId, Status.PENDING, Instant.now(), null, null, null);
    }

    public ReportJob running() {
        return new ReportJob(id, projectId, Status.RUNNING, createdAt, null, null, null);
    }

    public ReportJob done(ProjectReport report) {
        return new ReportJob(id, projectId, Status.DONE, createdAt, Instant.now(), report, null);
    }

    public ReportJob failed(String message) {
        return new ReportJob(id, projectId, Status.FAILED, createdAt, Instant.now(), null, message);
    }
}
~~~

~~~java src/main/java/com/example/taskflow/dto/ProjectReport.java
package com.example.taskflow.dto;

import java.util.Map;

public record ProjectReport(
        Long projectId,
        String projectName,
        long totalTasks,
        long overdueTasks,
        Map<String, Long> tasksByStatus) {
}
~~~

We need two queries in the existing ^TaskRepository^ (changed file, shown in full):

~~~java src/main/java/com/example/taskflow/repository/TaskRepository.java
package com.example.taskflow.repository;

import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.time.LocalDate;
import java.util.List;

public interface TaskRepository extends JpaRepository<Task, Long> {

    Page<Task> findByProjectId(Long projectId, Pageable pageable);

    long countByProjectId(Long projectId);

    long countByProjectIdAndDueDateBeforeAndStatusNot(Long projectId, LocalDate date, TaskStatus status);

    @Query("select t.status as status, count(t) as total from Task t "
         + "where t.project.id = :projectId group by t.status")
    List<StatusCount> countByStatus(Long projectId);

    @Query("select t from Task t join fetch t.assignee "
         + "where t.dueDate < :today and t.status <> com.example.taskflow.model.TaskStatus.DONE")
    List<Task> findOverdueWithAssignee(LocalDate today);

    interface StatusCount {
        TaskStatus getStatus();
        long getTotal();
    }
}
~~~

Now the service. Job state lives in a ^ConcurrentHashMap^: this is shared mutable state in a singleton, so it must be thread-safe (section 1.6). In production with multiple replicas you would store jobs in PostgreSQL or Redis; Exercise 3 asks you to reason about that.

~~~java src/main/java/com/example/taskflow/service/ReportService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.ProjectReport;
import com.example.taskflow.dto.ReportJob;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.TaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@Service
public class ReportService {

    private static final Logger log = LoggerFactory.getLogger(ReportService.class);

    private final ProjectRepository projectRepository;
    private final TaskRepository taskRepository;
    private final Map<UUID, ReportJob> jobs = new ConcurrentHashMap<>();

    public ReportService(ProjectRepository projectRepository, TaskRepository taskRepository) {
        this.projectRepository = projectRepository;
        this.taskRepository = taskRepository;
    }

    public ReportJob register(Long projectId) {
        UUID id = UUID.randomUUID();
        ReportJob job = ReportJob.pending(id, projectId);
        jobs.put(id, job);
        return job;
    }

    public Optional<ReportJob> find(UUID id) {
        return Optional.ofNullable(jobs.get(id));
    }

    /**
     * Runs on the "reportExecutor" (virtual threads, max 4 concurrently).
     * Called through the Spring proxy from ReportController, NOT from inside this class.
     */
    @Async("reportExecutor")
    @Transactional(readOnly = true)
    public CompletableFuture<ProjectReport> generate(UUID jobId) {
        jobs.computeIfPresent(jobId, (id, job) -> job.running());
        ReportJob job = jobs.get(jobId);
        log.info("Generating report for project {} on {}", job.projectId(), Thread.currentThread());
        try {
            Project project = projectRepository.findById(job.projectId())
                    .orElseThrow(() -> new ResourceNotFoundException("Project " + job.projectId() + " not found"));

            Map<String, Long> byStatus = taskRepository.countByStatus(project.getId()).stream()
                    .collect(Collectors.toMap(sc -> sc.getStatus().name(), TaskRepository.StatusCount::getTotal));

            ProjectReport report = new ProjectReport(
                    project.getId(),
                    project.getName(),
                    taskRepository.countByProjectId(project.getId()),
                    taskRepository.countByProjectIdAndDueDateBeforeAndStatusNot(
                            project.getId(), LocalDate.now(), TaskStatus.DONE),
                    byStatus);

            jobs.computeIfPresent(jobId, (id, j) -> j.done(report));
            return CompletableFuture.completedFuture(report);
        } catch (RuntimeException ex) {
            jobs.computeIfPresent(jobId, (id, j) -> j.failed(ex.getMessage()));
            return CompletableFuture.failedFuture(ex);
        }
    }
}
~~~

~~~java src/main/java/com/example/taskflow/controller/ReportController.java
package com.example.taskflow.controller;

import com.example.taskflow.dto.ReportJob;
import com.example.taskflow.service.ReportService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;
import java.util.UUID;

@RestController
@RequestMapping("/api/projects/{projectId}/reports")
public class ReportController {

    private final ReportService reportService;

    public ReportController(ReportService reportService) {
        this.reportService = reportService;
    }

    @PostMapping
    public ResponseEntity<ReportJob> start(@PathVariable Long projectId) {
        ReportJob job = reportService.register(projectId);
        reportService.generate(job.id());   // returns immediately, runs in background
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{jobId}").buildAndExpand(job.id()).toUri();
        return ResponseEntity.accepted().location(location).body(job);
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<?> status(@PathVariable Long projectId, @PathVariable UUID jobId) {
        return reportService.find(jobId)
                .filter(job -> job.projectId().equals(projectId))
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, "Report job not found")));
    }
}
~~~

Test it from PowerShell (assuming you stored a JWT from the login endpoint of lesson 7.2 in ^$token^):

~~~powershell
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body '{"email":"julian@example.com","password":"Secret123!"}').accessToken
$headers = @{ Authorization = "Bearer $token" }

$resp = Invoke-WebRequest -Method Post -Uri http://localhost:8080/api/projects/1/reports -Headers $headers
$resp.StatusCode            # 202
$resp.Headers.Location      # http://localhost:8080/api/projects/1/reports/3f0c...

Start-Sleep -Seconds 1
Invoke-RestMethod -Uri $resp.Headers.Location -Headers $headers | ConvertTo-Json -Depth 5
~~~

~~~json Expected output
{
  "id": "3f0c6a6e-7d0e-4c55-9a3b-1c1f3e1b8a10",
  "projectId": 1,
  "status": "DONE",
  "createdAt": "2026-11-20T20:01:12.311Z",
  "finishedAt": "2026-11-20T20:01:12.402Z",
  "result": {
    "projectId": 1,
    "projectName": "Website Relaunch",
    "totalTasks": 12,
    "overdueTasks": 3,
    "tasksByStatus": { "TODO": 5, "IN_PROGRESS": 4, "DONE": 3 }
  },
  "error": null
}
~~~

The log line shows ^VirtualThread[#78,report-1]/runnable@ForkJoinPool-1-worker-5^: proof that the work ran on our named virtual-thread executor.

### Step 5: Scheduled overdue reminders

~~~java src/main/java/com/example/taskflow/scheduling/OverdueTaskScheduler.java
package com.example.taskflow.scheduling;

import com.example.taskflow.model.Task;
import com.example.taskflow.repository.TaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

@Component
public class OverdueTaskScheduler {

    private static final Logger log = LoggerFactory.getLogger(OverdueTaskScheduler.class);

    private final TaskRepository taskRepository;
    private final AtomicLong heartbeat = new AtomicLong();   // thread-safe counter

    public OverdueTaskScheduler(TaskRepository taskRepository) {
        this.taskRepository = taskRepository;
    }

    /** Every weekday at 07:00 Berlin time. WARNING: runs on EVERY replica (see ShedLock). */
    @Scheduled(cron = "§{taskflow.scheduler.overdue-cron}", zone = "§{taskflow.scheduler.zone}")
    @Transactional(readOnly = true)
    public void sendOverdueDigest() {
        List<Task> overdue = taskRepository.findOverdueWithAssignee(LocalDate.now());
        Map<String, Long> perUser = overdue.stream()
                .collect(Collectors.groupingBy(t -> t.getAssignee().getEmail(), Collectors.counting()));
        perUser.forEach((email, count) ->
                log.info("Would email {} about {} overdue task(s)", email, count));
    }

    /** fixedDelay: next run starts 60 s after the previous one FINISHED, so runs never overlap. */
    @Scheduled(fixedDelay = 60_000, initialDelay = 10_000)
    public void heartbeat() {
        log.debug("Scheduler heartbeat #{} on {}", heartbeat.incrementAndGet(), Thread.currentThread());
    }
}
~~~

With ShedLock you would add ^@SchedulerLock(name = "overdueDigest", lockAtMostFor = "PT10M", lockAtLeastFor = "PT1M")^ to ^sendOverdueDigest^, plus ^@EnableSchedulerLock^, a ^LockProvider^ bean and a Flyway migration that creates the ^shedlock^ table. That is Exercise 2.

### Step 6: A reactive event stream with Server-Sent Events

Server-Sent Events (SSE) is a simple HTTP standard: the server keeps the response open with ^Content-Type: text/event-stream^ and pushes ^data:^ lines. Browsers consume it with ^EventSource^. Perfect for "task updated" notifications on a board.

We use a Reactor **Sink**, a thread-safe bridge from imperative code (our ^TaskService^) into a reactive ^Flux^. ^multicast().onBackpressureBuffer()^ makes it a hot stream shared by all subscribers with a bounded buffer.

~~~java src/main/java/com/example/taskflow/dto/TaskEvent.java
package com.example.taskflow.dto;

import java.time.Instant;

public record TaskEvent(
        Type type,
        Long taskId,
        Long projectId,
        String title,
        String status,
        Instant occurredAt) {

    public enum Type { CREATED, UPDATED, DELETED }
}
~~~

~~~java src/main/java/com/example/taskflow/service/TaskEventPublisher.java
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Sinks;

@Component
public class TaskEventPublisher {

    private static final Logger log = LoggerFactory.getLogger(TaskEventPublisher.class);

    // Hot, multicast sink; buffers up to 256 events per slow subscriber, then drops for that subscriber.
    private final Sinks.Many<TaskEvent> sink =
            Sinks.many().multicast().onBackpressureBuffer(256, false);

    /** Only publish AFTER the DB transaction committed, so clients never see rolled-back changes. */
    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    public void onTaskEvent(TaskEvent event) {
        // emitNext with a retry handler is safe when several threads emit concurrently
        sink.emitNext(event, Sinks.EmitFailureHandler.busyLooping(java.time.Duration.ofMillis(50)));
        log.debug("Published {}", event);
    }

    public Flux<TaskEvent> stream() {
        return sink.asFlux();
    }
}
~~~

Now the changed ^TaskService^. It publishes a Spring application event inside the transaction; the listener above forwards it to the sink only after commit. Only the relevant parts of TaskFlow's service are shown in full form below (the class is complete and compiles with the lesson 7.x entities).

~~~java src/main/java/com/example/taskflow/service/TaskService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskEvent;
import com.example.taskflow.dto.TaskRequest;
import com.example.taskflow.dto.TaskResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.TaskRepository;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Service
@Transactional(readOnly = true)
public class TaskService {

    private final TaskRepository taskRepository;
    private final ProjectRepository projectRepository;
    private final ApplicationEventPublisher events;

    public TaskService(TaskRepository taskRepository,
                       ProjectRepository projectRepository,
                       ApplicationEventPublisher events) {
        this.taskRepository = taskRepository;
        this.projectRepository = projectRepository;
        this.events = events;
    }

    public Page<TaskResponse> findByProject(Long projectId, Pageable pageable) {
        return taskRepository.findByProjectId(projectId, pageable).map(TaskResponse::from);
    }

    @Transactional
    public TaskResponse create(Long projectId, TaskRequest request) {
        Project project = projectRepository.findById(projectId)
                .orElseThrow(() -> new ResourceNotFoundException("Project " + projectId + " not found"));
        Task task = new Task();
        task.setTitle(request.title());
        task.setDescription(request.description());
        task.setDueDate(request.dueDate());
        task.setStatus(TaskStatus.TODO);
        task.setProject(project);
        Task saved = taskRepository.save(task);
        publish(TaskEvent.Type.CREATED, saved);
        return TaskResponse.from(saved);
    }

    @Transactional
    public TaskResponse updateStatus(Long taskId, TaskStatus status) {
        Task task = taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task " + taskId + " not found"));
        task.setStatus(status);
        publish(TaskEvent.Type.UPDATED, task);
        return TaskResponse.from(task);
    }

    @Transactional
    public void delete(Long taskId) {
        Task task = taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task " + taskId + " not found"));
        taskRepository.delete(task);
        publish(TaskEvent.Type.DELETED, task);
    }

    private void publish(TaskEvent.Type type, Task task) {
        events.publishEvent(new TaskEvent(type, task.getId(), task.getProject().getId(),
                task.getTitle(), task.getStatus().name(), Instant.now()));
    }
}
~~~

The streaming controller returns a ^Flux^ from a normal MVC controller. Spring MVC detects the reactive type and writes each element as an SSE event using async servlet support; no Tomcat thread is held while waiting. We merge a heartbeat every 15 seconds so proxies and load balancers do not close an idle connection.

~~~java src/main/java/com/example/taskflow/controller/TaskStreamController.java
package com.example.taskflow.controller;

import com.example.taskflow.dto.TaskEvent;
import com.example.taskflow.service.TaskEventPublisher;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;

import java.time.Duration;

@RestController
@RequestMapping("/api/projects/{projectId}/tasks")
public class TaskStreamController {

    private final TaskEventPublisher publisher;

    public TaskStreamController(TaskEventPublisher publisher) {
        this.publisher = publisher;
    }

    @GetMapping(path = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<TaskEvent>> stream(@PathVariable Long projectId) {
        Flux<ServerSentEvent<TaskEvent>> events = publisher.stream()
                .filter(e -> e.projectId().equals(projectId))
                .map(e -> ServerSentEvent.<TaskEvent>builder()
                        .id(e.taskId() + "-" + e.occurredAt().toEpochMilli())
                        .event(e.type().name().toLowerCase())
                        .data(e)
                        .build());

        Flux<ServerSentEvent<TaskEvent>> heartbeat = Flux.interval(Duration.ofSeconds(15))
                .map(tick -> ServerSentEvent.<TaskEvent>builder().comment("keep-alive").build());

        return Flux.merge(events, heartbeat);
    }
}
~~~

Security note: the endpoint is under ^/api/^ and therefore protected by the JWT filter chain from lesson 7.2. In real life you would also verify the caller is a member of the project (method security, ^@PreAuthorize^). Browser ^EventSource^ cannot send custom headers, so frontends usually use a fetch-based SSE client or a short-lived ticket in a cookie.

Try it with two PowerShell windows. Use ^curl.exe^ (the real curl shipped with Windows, not the PowerShell alias) because it streams output:

~~~powershell
# Window 1: subscribe (-N disables buffering)
curl.exe -N -H "Authorization: Bearer $token" http://localhost:8080/api/projects/1/tasks/stream

# Window 2: change a task
Invoke-RestMethod -Method Patch -Uri http://localhost:8080/api/tasks/7/status -Headers $headers -ContentType "application/json" -Body '{"status":"DONE"}'
~~~

~~~text Expected output in window 1
:keep-alive

id:7-1795723512000
event:updated
data:{"type":"UPDATED","taskId":7,"projectId":1,"title":"Write release notes","status":"DONE","occurredAt":"2026-11-20T20:05:12Z"}
~~~

### Step 7: Reactor basics in a test, and WebClient

Learn the operators in isolation with ^StepVerifier^ from ^reactor-test^:

~~~java src/test/java/com/example/taskflow/ReactorBasicsTest.java
package com.example.taskflow;

import org.junit.jupiter.api.Test;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

import java.time.Duration;

class ReactorBasicsTest {

    @Test
    void mapFilterAndFlatMap() {
        Flux<String> titles = Flux.just("plan", "build", "test", "ship")
                .filter(s -> s.length() > 4)              // "build"
                .map(String::toUpperCase)                  // "BUILD"
                .flatMap(s -> Mono.just(s + "!"));         // async-capable transformation

        StepVerifier.create(titles)
                .expectNext("BUILD!")
                .verifyComplete();
    }

    @Test
    void zipCombinesResults() {
        Mono<Integer> open = Mono.just(5);
        Mono<Integer> done = Mono.just(3);
        StepVerifier.create(Mono.zip(open, done, Integer::sum))
                .expectNext(8)
                .verifyComplete();
    }

    @Test
    void backpressureLimitsDemand() {
        StepVerifier.create(Flux.range(1, 1_000), 2)   // subscriber requests only 2
                .expectNext(1, 2)
                .thenRequest(1)
                .expectNext(3)
                .thenCancel()
                .verify();
    }

    @Test
    void timeoutFallsBack() {
        Mono<String> slow = Mono.just("late").delayElement(Duration.ofSeconds(2))
                .timeout(Duration.ofMillis(100))
                .onErrorReturn("fallback");
        StepVerifier.create(slow).expectNext("fallback").verifyComplete();
    }
}
~~~

For outgoing HTTP calls, ^WebClient^ is the reactive client; in a servlet app on virtual threads, the newer synchronous ^RestClient^ is equally good. Here is a ^WebClient^ calling a hypothetical holiday API concurrently for several countries; ^flatMap^ runs requests in parallel without using a thread per request:

~~~java src/main/java/com/example/taskflow/service/HolidayClient.java
package com.example.taskflow.service;

import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;

import java.time.Duration;
import java.time.LocalDate;
import java.util.List;

@Component
public class HolidayClient {

    private final WebClient webClient;

    public HolidayClient(WebClient.Builder builder) {
        this.webClient = builder.baseUrl("https://date.nager.at/api/v3").build();
    }

    public record Holiday(LocalDate date, String localName, String countryCode) { }

    public Flux<Holiday> holidays(int year, List<String> countries) {
        return Flux.fromIterable(countries)
                .flatMap(code -> webClient.get()
                        .uri("/PublicHolidays/{year}/{code}", year, code)
                        .retrieve()
                        .bodyToFlux(Holiday.class)
                        .timeout(Duration.ofSeconds(3))
                        .onErrorResume(ex -> Flux.empty()), 4);   // at most 4 concurrent calls
    }
}
~~~

A fully reactive variant (WebFlux on Netty, R2DBC repository) would look like ^interface TaskR2dbcRepository extends ReactiveCrudRepository^ with methods returning ^Flux^ of tasks, and controllers returning ^Mono^ of ResponseEntity. We deliberately do **not** do that in TaskFlow because JPA, Flyway and our security setup are blocking and work perfectly with virtual threads.

### Step 8: Load testing to see the difference

Theory is nice; measurements convince. Add a deliberately slow endpoint (simulating a slow downstream service) to a dev profile, then hammer it.

~~~java src/main/java/com/example/taskflow/controller/SlowController.java
package com.example.taskflow.controller;

import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Profile("dev")
public class SlowController {

    @GetMapping("/api/diagnostics/slow")
    public String slow() throws InterruptedException {
        Thread.sleep(500);   // pretend a downstream call takes 500 ms
        return "ok";
    }
}
~~~

Use **oha** (a single-binary HTTP load generator, install with ^winget install hatoo.oha^) or **k6** (^winget install k6^). Run it twice: once with ^spring.threads.virtual.enabled=false^, once with ^true^.

~~~powershell
oha -n 4000 -c 1000 -H "Authorization: Bearer $token" http://localhost:8080/api/diagnostics/slow
~~~

~~~text Typical results on a laptop
Platform threads (max 200):  Requests/sec ~ 395    p99 latency ~ 2.6 s
Virtual threads:             Requests/sec ~ 1900   p99 latency ~ 0.56 s
~~~

With 200 platform threads and 500 ms per request, the theoretical maximum is 400 req/s. Virtual threads remove that ceiling. Now change ^Thread.sleep^ into a real database query and watch the gain shrink: Hikari's 20 connections become the limit. That is the "pool sizing still matters" lesson in numbers.

## 3. Common Pitfalls & Best Practices

- **Mistake:** Calling an ^@Async^ method from another method in the same class and wondering why it is synchronous. **Fix:** Call it through another bean (the proxy), as ^ReportController^ calls ^ReportService.generate^.
- **Mistake:** Enabling virtual threads and expecting the database to scale too. **Fix:** Size HikariCP for PostgreSQL's capacity, set a short ^connection-timeout^, and throttle heavy work with concurrency limits or semaphores.
- **Mistake:** Long blocking calls inside ^synchronized^ on Java 21 (pinning). **Fix:** Use ^ReentrantLock^ in your code, upgrade to JDK 24+ when possible, and check JFR for ^jdk.VirtualThreadPinned^ events.
- **Mistake:** Storing request data in a field of a singleton bean (^private User currentUser^). **Fix:** Keep request state in parameters and local variables; use ^ConcurrentHashMap^ or atomics for truly shared state.
- **Mistake:** Running ^@Scheduled^ jobs on every replica and sending duplicate emails. **Fix:** Use ShedLock, a single worker deployment or a Kubernetes CronJob.
- **Mistake:** Calling JPA or other blocking code inside a WebFlux pipeline on the event loop. **Fix:** Use R2DBC end to end, or stay on MVC with virtual threads; detect blocking with BlockHound.
- **Mistake:** Building a reactive pipeline and never subscribing, or calling ^block()^ inside a reactive flow. **Fix:** Return the ^Mono^/^Flux^ to the framework and let it subscribe; only block at true boundaries such as tests.
- **Mistake:** Publishing SSE events before the transaction commits. **Fix:** Use ^@TransactionalEventListener(phase = AFTER_COMMIT)^ as in ^TaskEventPublisher^.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Measure virtual threads in TaskFlow","tasks":["Add the ^DiagnosticsController^ and confirm with a GET request that ^virtual^ is true when ^spring.threads.virtual.enabled=true^ and false when you set it to false.","Create the dev-only ^SlowController^ and run oha or k6 with 1000 concurrent connections in both modes; record requests per second and p99 latency in a small table.","Replace ^Thread.sleep^ with a call to ^taskRepository.count()^ followed by a 200 ms sleep inside the same transaction, set ^maximum-pool-size^ to 5, and observe what happens to latency and errors.","Write two sentences explaining the result using the terms carrier thread, connection pool and bottleneck."]},
{"title":"Exercise 2 (Challenge): Make the scheduler cluster-safe with ShedLock","tasks":["Read the ShedLock README and add ^shedlock-spring^ and ^shedlock-provider-jdbc-template^ to ^pom.xml^.","Create a Flyway migration ^V8__create_shedlock.sql^ with the ^shedlock^ table required by the JDBC provider for PostgreSQL.","Add a ^LockProvider^ bean using ^JdbcTemplateLockProvider^ with database time, annotate the config with ^@EnableSchedulerLock^ and protect ^sendOverdueDigest^ with ^@SchedulerLock^.","Start two TaskFlow instances on ports 8080 and 8081 against the same database, change the cron to run every minute, and prove from the logs that only one instance executes each run."]},
{"title":"Exercise 3 (Thinking): Design decisions under concurrency","tasks":["The ^ReportService^ keeps jobs in a ^ConcurrentHashMap^. Explain what breaks when TaskFlow runs with 3 replicas behind a load balancer, and propose two alternative storage designs with their trade-offs.","The SSE sink lives in memory on one instance. Describe how a task update made on replica A could reach a client connected to replica B (consider PostgreSQL LISTEN/NOTIFY, Redis pub/sub or a message broker).","A colleague proposes migrating TaskFlow to WebFlux and R2DBC for performance. Using the decision table from this lesson, write a short recommendation with at least three concrete arguments.","Identify one place in your own TaskFlow code where a singleton bean has mutable state, and explain whether it is thread-safe and why."]}
]
};
