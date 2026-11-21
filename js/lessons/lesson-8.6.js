LESSONS['8.6']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** TaskFlow (^com.example.taskflow^) has User, Project and Task entities, JWT security, PostgreSQL with Flyway, Docker Compose (7.1-7.3), and since lesson 8.5 a resilient ^RestClient^ call to an email provider protected by Resilience4j with an outbox fallback. It already exposes ^/actuator/health^. What it lacks is the ability to answer, in production, "is it working, how well, and where is it slow?" This lesson adds metrics, tracing, log correlation, and a local Prometheus + Grafana + Tempo stack.

**New files:** ^TaskMetrics^, ^ObservabilityConfig^, ^ProjectReportService^ observation example, ^observability/prometheus.yml^, ^observability/alerts.yml^, ^observability/tempo.yaml^, ^observability/grafana/provisioning/datasources/datasources.yml^, ^observability/grafana/provisioning/dashboards/dashboards.yml^, ^observability/grafana/dashboards/taskflow.json^, ^TaskMetricsTest^. **Changed files:** ^pom.xml^, ^application.yml^, ^TaskService^, ^SecurityConfig^ (permit the scrape endpoint), ^docker-compose.yml^.

### 1.1 Monitoring vs observability, and the three pillars

**Monitoring** answers known questions ("is CPU above 90%?"). **Observability** is the property of a system that lets you answer questions you did not anticipate ("why are task assignments slow only for project 42 since the 14:05 deploy?") from its outputs. Those outputs are traditionally grouped in three pillars:

| Pillar | What it is | Strength | Weakness | TaskFlow tool |
|---|---|---|---|---|
| Logs | Timestamped discrete events with context | Rich detail, exact errors | Expensive at volume, hard to aggregate | Logback (JSON from 6.x) |
| Metrics | Numeric time series aggregated over time | Cheap, fast queries, alerting | No per-request detail | Micrometer + Prometheus |
| Traces | Tree of timed spans for one request across services | Shows where time is spent, causality | Sampled, storage heavy | Micrometer Tracing + OpenTelemetry + Tempo/Jaeger |

The pillars are most powerful when **correlated**: an alert fires on a metric, you click an exemplar to the slow trace, and from the trace id you jump to the exact log lines. Building that chain is the goal of this lesson.

Analogy: a hospital. Metrics are the vital-signs monitor (heart rate, blood pressure - continuous numbers, alarms on thresholds). Logs are the nurse's notes (what happened, when, in words). A trace is following one patient through admission, X-ray, lab and surgery with a stopwatch at each department.

### 1.2 Micrometer: the SLF4J of metrics

Micrometer is a vendor-neutral facade. You code against ^MeterRegistry^ and meter types; a registry implementation (^micrometer-registry-prometheus^, Datadog, CloudWatch, OTLP...) translates them for the backend. Spring Boot auto-configures a ^MeterRegistry^ bean and instruments a lot for you: HTTP server requests (^http.server.requests^), ^RestClient^ calls (^http.client.requests^), JVM memory/GC/threads, HikariCP pools, Tomcat, logback events, Spring Data repositories, and the Resilience4j meters from 8.5.

The core meter types:

| Type | Measures | Example in TaskFlow | Prometheus exposition |
|---|---|---|---|
| Counter | Monotonically increasing count | tasks created | taskflow_tasks_created_total |
| Timer | Count + total time + max (+ optional histogram) of short events | outbound email call duration | taskflow_x_seconds_count, _sum, _max, _bucket |
| Gauge | Current value sampled on read | open tasks right now, outbox backlog | taskflow_tasks_open |
| DistributionSummary | Distribution of non-time values | tasks per project creation batch, payload size | _count, _sum, _max, _bucket |
| LongTaskTimer | Duration of in-flight long tasks | running report export | _active_count, _duration_sum |

A note on **task completion time**: a Timer is designed for things you measure in-process (start a sample, stop it). The time between "task created" and "task completed" spans days and different requests, so we record it with ^Timer.record(Duration)^ computed from the entity's timestamps at completion time. That is legitimate and is how we will produce ^taskflow_task_completion_seconds^.

### 1.3 Tags and the cardinality danger

Each unique combination of meter name + tag values is a separate **time series**. ^http.server.requests^ with tags method, uri, status, outcome, exception might be 6 x 40 x 8 x 3 x 5 series - already thousands. Prometheus keeps recent series in memory; every series costs RAM, disk, and query time. The classic production incident: someone adds ^userId^ or ^taskId^ as a tag. With 200,000 users that is 200,000 new series per meter; Prometheus slows, OOMs, and your monitoring dies exactly when you need it.

Rules:

- Tags must have a **small, bounded** set of values: status, priority (LOW/MEDIUM/HIGH), outcome, region. Tens, not thousands.
- Never tag with ids, emails, raw URLs with ids, free text, or exception messages. Spring uses URI **templates** (^/api/tasks/{id}^) for this reason.
- High-cardinality context belongs in **logs and traces**, which are per-event, not in metric tags.
- Use a ^MeterFilter^ to cap or deny tags defensively (^MeterFilter.maximumAllowableTags^).

### 1.4 The Observation API: instrument once, get metrics and traces

Boot 3 / Micrometer 1.10+ introduced the **Observation API**. Instead of writing timing code and tracing code separately, you create an ^Observation^; registered **handlers** turn it into whatever they need: ^DefaultMeterObservationHandler^ creates a Timer (and a LongTaskTimer), the tracing handler creates a span, and you can add your own (e.g. audit logging). This is how Spring instruments itself internally: the MVC filter, ^RestClient^, JDBC (with extra libs), scheduled tasks, security filter chain.

~~~text
Observation.createNotStarted("taskflow.report", registry)
     |  start()       -> TimerSample started, Span started, MDC traceId set
     |  scoped work   -> nested observations become child spans
     |  error(e)      -> span marked error, tag exception=...
     v  stop()        -> Timer recorded (taskflow.report seconds), span ended & exported
~~~

**Low-cardinality key values** become metric tags AND span tags. **High-cardinality key values** become span tags only - so you can put ^project.id^ there safely. This one distinction solves the cardinality dilemma elegantly.

Annotations:

- ^@Timed^ (Micrometer) creates a Timer only. Requires a ^TimedAspect^ bean for arbitrary beans.
- ^@Observed^ creates an Observation (metrics + traces). Requires an ^ObservedAspect^ bean. In Boot 3.2+ ^ObservedAspect^ is auto-configured when AOP is on the classpath (^management.observations.annotations.enabled=true^ in Boot 3.4+ turns on support for ^@Observed^, ^@Timed^ and ^@Counted^ aspects). Same proxy rule as 8.5: no self-invocation.

### 1.5 What to measure: RED, USE, SLIs and SLOs

**RED** (for request-driven services, by Tom Wilkie): **R**ate (requests/s), **E**rrors (failed requests/s), **D**uration (latency distribution). Every TaskFlow endpoint gets RED from ^http.server.requests^ for free.

**USE** (for resources, by Brendan Gregg): **U**tilization, **S**aturation, **E**rrors. Apply to CPU, heap, DB connection pool (^hikaricp_connections_active^ vs max, ^hikaricp_connections_pending^), the bulkhead from 8.5.

An **SLI** (service level indicator) is a measured ratio of good events to total, e.g. "proportion of ^POST /api/tasks^ requests that succeed in under 500 ms". An **SLO** is the target: "99.5% over 28 days". The remaining 0.5% is the **error budget**. Alerts should page humans when the budget burns too fast (multi-window burn-rate alerts), not on every CPU spike. Alert on **symptoms** users feel (errors, latency), investigate with **causes** (pool saturation, GC).

To compute "under 500 ms" you need histogram buckets: enable ^percentiles-histogram^ and ^slo^ boundaries for the timer. Then PromQL can compute ^histogram_quantile^ and good/total ratios across instances. Client-side ^percentiles^ (pre-computed p95 in the app) cannot be aggregated across pods - prefer histograms.

### 1.6 Distributed tracing concepts

- **Trace**: the whole journey of one request, identified by a 128-bit **trace id**.
- **Span**: one timed operation within the trace (HTTP server handling, a DB query, the outbound email call), with a 64-bit **span id**, a parent span id, a name, tags, events, and status.
- **Context propagation**: when TaskFlow calls the email service, it injects headers so the next service continues the same trace. The standard is **W3C Trace Context**: ^traceparent: 00-<trace-id>-<span-id>-<flags>^ plus optional ^tracestate^. (Older systems use B3 headers from Zipkin.) Spring's instrumented ^RestClient.Builder^ adds the header automatically; the server side extracts it in the observation filter.
- **Sampling**: tracing every request is expensive. **Head sampling** decides at the start (e.g. 10% probability) and propagates the decision in the flags. **Tail sampling** (in the OpenTelemetry Collector) decides after the trace completes - keep all errors and slow traces, 5% of the rest. Boot's default probability is 0.1; locally we set 1.0.

Under the hood in Boot 3: ^micrometer-tracing^ is a facade (like Micrometer for metrics) with bridges to **OpenTelemetry** (^micrometer-tracing-bridge-otel^) or Brave. A ^TracingObservationHandler^ converts observations to spans; an exporter (^opentelemetry-exporter-otlp^) ships them using the **OTLP** protocol to a backend: Grafana Tempo, Jaeger (which accepts OTLP natively since 1.35), or an **OTel Collector** that can fan out, batch, filter and tail-sample.

### 1.7 Correlating logs with traces

When a span is in scope, Micrometer Tracing puts ^traceId^ and ^spanId^ into the SLF4J **MDC** (mapped diagnostic context - a thread-local map Logback can print). Boot 3.2+ adds them to the default log pattern automatically via ^logging.pattern.correlation^, and with structured logging (Boot 3.4 ^logging.structured.format.console=ecs^ or ^logstash^) they appear as JSON fields. So any log line can be joined to its trace. With virtual threads or ^@Async^, context must be propagated: Boot configures ^ContextPropagatingTaskDecorator^ when you set ^spring.task.execution^ properly or register it yourself.

### 1.8 Health vs metrics, and the cost of observability

Health (^/actuator/health^) is a **binary, current** answer for orchestrators: should I route traffic / restart this pod? Metrics are **historical, numeric** data for humans and alerting. Do not try to alert on health polling; do not expose detailed health publicly.

Observability costs money and CPU:

| Cost | Driver | Mitigation |
|---|---|---|
| Metric storage | Number of series (cardinality) x retention | Bounded tags, drop unused meters with MeterFilter, recording rules |
| Histogram buckets | Each bucket is a series | Enable histograms only on SLO-relevant timers |
| Trace volume | Requests x spans x sampling rate | Head sampling 5-10%, tail sampling for errors |
| Log volume | Lines x size | INFO in prod, no payload logging, sample debug logs |
| App overhead | Instrumentation on hot paths | Usually under 1-3% CPU; measure before/after |

SaaS vendors charge by series, spans and GB ingested; a careless tag can cost thousands per month. Treat telemetry as a product with a budget.

---

## 2. Code Walkthrough

### Step 1: Dependencies

~~~xml pom.xml (dependencies section - additions)
<!-- Prometheus exposition format at /actuator/prometheus -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
<!-- Tracing facade bridged to OpenTelemetry -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<!-- Export spans via OTLP (to Tempo, Jaeger, or an OTel Collector) -->
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>
<!-- Already added in 8.5; needed for @Observed / @Timed aspects -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
~~~

All versions come from the Spring Boot BOM. Since Micrometer 1.13 (Boot 3.3+) the Prometheus registry uses the Prometheus Java client 1.x; the old ^simpleclient^ variant is deprecated - do not add it.

### Step 2: Configuration

~~~yaml src/main/resources/application.yml (additions)
spring:
  application:
    name: taskflow

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus,circuitbreakers,circuitbreakerevents
  endpoint:
    health:
      probes:
        enabled: true
  metrics:
    tags:
      application: §{spring.application.name}
      env: §{TASKFLOW_ENV:local}
    distribution:
      percentiles-histogram:
        http.server.requests: true
        taskflow.task.completion: true
      slo:
        http.server.requests: 100ms,250ms,500ms,1s,2s
      minimum-expected-value:
        taskflow.task.completion: 1m
      maximum-expected-value:
        taskflow.task.completion: 30d
  observations:
    annotations:
      enabled: true
    key-values:
      application: §{spring.application.name}
  tracing:
    sampling:
      probability: §{TRACING_SAMPLING:1.0}
    propagation:
      type: w3c
  otlp:
    tracing:
      endpoint: §{OTLP_TRACES_ENDPOINT:http://localhost:4318/v1/traces}
  prometheus:
    metrics:
      export:
        enabled: true

logging:
  pattern:
    correlation: "[§{spring.application.name:},%X{traceId:-},%X{spanId:-}] "
  include-application-name: false
~~~

Notes: the common tag ^application^ lets one Prometheus serve many services. ^percentiles-histogram^ is enabled only for two timers to control cost. Production sets ^TRACING_SAMPLING=0.1^. The OTLP endpoint uses HTTP/protobuf on port 4318 (gRPC is 4317).

### Step 3: Allow Prometheus to scrape

The JWT ^SecurityConfig^ from 7.2 protects everything. The scrape endpoint should be reachable by Prometheus but not the internet; in Kubernetes you would expose actuator on a separate management port (^management.server.port: 8081^) that is not routed through the ingress. For Compose we permit it and keep other actuator endpoints restricted.

~~~java src/main/java/com/example/taskflow/security/SecurityConfig.java
package com.example.taskflow.security;

import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthenticationFilter;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        return http
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(EndpointRequest.to("health", "prometheus")).permitAll()
                        .requestMatchers(EndpointRequest.toAnyEndpoint()).hasRole("ADMIN")
                        .requestMatchers("/api/auth/**").permitAll()
                        .anyRequest().authenticated())
                .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class)
                .httpBasic(Customizer.withDefaults())
                .build();
    }
}
~~~

(If your 7.2 config defines ^PasswordEncoder^ and ^AuthenticationManager^ beans in this class, keep them; only the authorization rules changed.)

### Step 4: Custom business metrics

Technical metrics tell you the app is up; **business metrics** tell you it is useful. We add ^taskflow_tasks_created_total^ (Counter, tagged by priority), ^taskflow_tasks_completed_total^, ^taskflow_task_completion_seconds^ (Timer from creation to completion), ^taskflow_tasks_open^ (Gauge from the DB) and ^taskflow_notification_outbox_pending^ (Gauge for 8.5's outbox).

~~~java src/main/java/com/example/taskflow/metrics/TaskMetrics.java
package com.example.taskflow.metrics;

import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.notification.OutboxNotificationRepository;
import com.example.taskflow.repository.TaskRepository;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;

@Component
public class TaskMetrics {

    private final MeterRegistry registry;
    private final Timer completionTimer;
    private final DistributionSummary titleLength;
    private final AtomicLong openTasks = new AtomicLong();
    private final AtomicLong pendingOutbox = new AtomicLong();

    public TaskMetrics(MeterRegistry registry) {
        this.registry = registry;

        // Exposed as taskflow_task_completion_seconds_{count,sum,max,bucket}
        this.completionTimer = Timer.builder("taskflow.task.completion")
                .description("Time from task creation until it is marked DONE")
                .register(registry);

        this.titleLength = DistributionSummary.builder("taskflow.task.title.length")
                .description("Length of task titles in characters")
                .baseUnit("characters")
                .serviceLevelObjectives(10, 40, 80, 200)
                .register(registry);

        // Gauges hold a reference to a value holder; Micrometer reads it on each scrape.
        Gauge.builder("taskflow.tasks.open", openTasks, AtomicLong::get)
                .description("Tasks not yet DONE (refreshed periodically)")
                .register(registry);
        Gauge.builder("taskflow.notification.outbox.pending", pendingOutbox, AtomicLong::get)
                .description("Notifications waiting for redelivery")
                .register(registry);
    }

    /** taskflow_tasks_created_total{priority="HIGH"} - priority is a bounded enum, safe as a tag. */
    public void taskCreated(Task task) {
        Counter.builder("taskflow.tasks.created")
                .description("Tasks created")
                .tag("priority", task.getPriority().name())
                .register(registry)   // returns the existing counter after the first call
                .increment();
        titleLength.record(task.getTitle().length());
    }

    public void taskCompleted(Task task) {
        Counter.builder("taskflow.tasks.completed")
                .tag("priority", task.getPriority().name())
                .register(registry)
                .increment();
        Duration age = Duration.between(task.getCreatedAt(), Instant.now());
        if (!age.isNegative()) {
            completionTimer.record(age);
        }
    }

    public void refreshGauges(TaskRepository tasks, OutboxNotificationRepository outbox) {
        openTasks.set(tasks.countByStatusNot(TaskStatus.DONE));
        pendingOutbox.set(outbox.countBySentAtIsNull());
    }
}
~~~

Why not a gauge that runs a SQL count on every scrape? Gauges are evaluated on the scrape thread every 15 s by every Prometheus replica; a slow query there blocks the scrape and hammers the DB. Refreshing a cached value on a schedule decouples the two:

~~~java src/main/java/com/example/taskflow/metrics/GaugeRefresher.java
package com.example.taskflow.metrics;

import com.example.taskflow.notification.OutboxNotificationRepository;
import com.example.taskflow.repository.TaskRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
class GaugeRefresher {

    private final TaskMetrics metrics;
    private final TaskRepository tasks;
    private final OutboxNotificationRepository outbox;

    GaugeRefresher(TaskMetrics metrics, TaskRepository tasks, OutboxNotificationRepository outbox) {
        this.metrics = metrics;
        this.tasks = tasks;
        this.outbox = outbox;
    }

    @Scheduled(fixedDelayString = "PT30S")
    void refresh() {
        metrics.refreshGauges(tasks, outbox);
    }
}
~~~

Add the two count methods to the repositories: ^long countByStatusNot(TaskStatus status)^ in ^TaskRepository^ and ^long countBySentAtIsNull()^ in ^OutboxNotificationRepository^. This assumes the ^Task^ entity from 7.1 has ^status^ (TaskStatus enum TODO, IN_PROGRESS, DONE), ^priority^ and ^createdAt^ fields; if your ^createdAt^ is missing, add it with a Flyway migration ^V8__task_created_at.sql^.

### Step 5: Use the metrics in TaskService and add an observation

~~~java src/main/java/com/example/taskflow/service/TaskService.java (changed methods)
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskRequest;
import com.example.taskflow.dto.TaskResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.metrics.TaskMetrics;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.notification.NotificationService;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.TaskRepository;
import com.example.taskflow.repository.UserRepository;
import io.micrometer.observation.annotation.Observed;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskService {

    private static final Logger log = LoggerFactory.getLogger(TaskService.class);

    private final TaskRepository taskRepository;
    private final ProjectRepository projectRepository;
    private final UserRepository userRepository;
    private final NotificationService notificationService;
    private final TaskMetrics metrics;

    public TaskService(TaskRepository taskRepository, ProjectRepository projectRepository,
                       UserRepository userRepository, NotificationService notificationService,
                       TaskMetrics metrics) {
        this.taskRepository = taskRepository;
        this.projectRepository = projectRepository;
        this.userRepository = userRepository;
        this.notificationService = notificationService;
        this.metrics = metrics;
    }

    @Transactional
    @Observed(name = "taskflow.task.create", contextualName = "create-task",
              lowCardinalityKeyValues = {"layer", "service"})
    public TaskResponse create(Long projectId, TaskRequest request) {
        Project project = projectRepository.findById(projectId)
                .orElseThrow(() -> new ResourceNotFoundException("Project", projectId));
        Task task = taskRepository.save(new Task(request.title(), request.description(), request.priority(), project));
        metrics.taskCreated(task);
        log.info("Task created id={} project={}", task.getId(), projectId);  // traceId is added by the log pattern
        return TaskResponse.from(task, false);
    }

    @Transactional
    public TaskResponse complete(Long taskId) {
        Task task = taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
        if (task.getStatus() != TaskStatus.DONE) {
            task.setStatus(TaskStatus.DONE);
            metrics.taskCompleted(task);
        }
        return TaskResponse.from(task, false);
    }

    // assign(...) from lesson 8.5 and the read methods remain unchanged
}
~~~

Note the idempotency check in ^complete^: completing an already-DONE task must not count twice, otherwise the metric lies.

### Step 6: The programmatic Observation API with high-cardinality context

~~~java src/main/java/com/example/taskflow/service/ProjectReportService.java
package com.example.taskflow.service;

import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.repository.TaskRepository;
import io.micrometer.observation.Observation;
import io.micrometer.observation.ObservationRegistry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.EnumMap;
import java.util.Map;

@Service
public class ProjectReportService {

    private final TaskRepository taskRepository;
    private final ObservationRegistry observationRegistry;

    public ProjectReportService(TaskRepository taskRepository, ObservationRegistry observationRegistry) {
        this.taskRepository = taskRepository;
        this.observationRegistry = observationRegistry;
    }

    @Transactional(readOnly = true)
    public Map<TaskStatus, Long> statusReport(Long projectId) {
        return Observation.createNotStarted("taskflow.report.status", observationRegistry)
                .contextualName("project-status-report")
                .lowCardinalityKeyValue("report", "status")              // metric tag + span tag
                .highCardinalityKeyValue("project.id", String.valueOf(projectId)) // span tag only
                .observe(() -> {
                    Map<TaskStatus, Long> result = new EnumMap<>(TaskStatus.class);
                    for (TaskStatus s : TaskStatus.values()) {
                        result.put(s, taskRepository.countByProjectIdAndStatus(projectId, s));
                    }
                    return result;
                });
    }
}
~~~

^observe()^ starts the observation, opens a scope (so MDC and the current span are set), runs the lambda, records errors, and stops it. The result: a timer ^taskflow_report_status_seconds{report="status",error="none"}^ and a span "project-status-report" with ^project.id=42^.

### Step 7: Defensive meter filters

~~~java src/main/java/com/example/taskflow/config/ObservabilityConfig.java
package com.example.taskflow.config;

import io.micrometer.core.instrument.config.MeterFilter;
import io.micrometer.observation.ObservationPredicate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.observation.ServerRequestObservationContext;

@Configuration
public class ObservabilityConfig {

    /** If someone ever tags http.server.requests by a raw URI, cap it at 100 values instead of melting Prometheus. */
    @Bean
    MeterFilter capUriCardinality() {
        return MeterFilter.maximumAllowableTags("http.server.requests", "uri", 100, MeterFilter.deny());
    }

    /** We do not need metrics for the JVM buffer pools - drop them to save series. */
    @Bean
    MeterFilter dropBufferMetrics() {
        return MeterFilter.denyNameStartsWith("jvm.buffer");
    }

    /** Do not create traces for Prometheus scrapes and health checks: pure noise and cost. */
    @Bean
    ObservationPredicate skipActuatorObservations() {
        return (name, context) -> {
            if (context instanceof ServerRequestObservationContext server) {
                return !server.getCarrier().getRequestURI().startsWith("/actuator");
            }
            return true;
        };
    }
}
~~~

### Step 8: Run and check the endpoint

~~~powershell
./mvnw spring-boot:run
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body '{"email":"julian@example.com","password":"secret123"}').token
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/projects/1/tasks -Headers @{Authorization = "Bearer $token"} -ContentType "application/json" -Body '{"title":"Write docs","description":"Lesson 8.6","priority":"HIGH"}'
~~~

Now filter the scrape output for the custom metrics:

~~~powershell
(Invoke-WebRequest http://localhost:8080/actuator/prometheus).Content | Select-String -AllMatches "taskflow_tasks_created_total.*" | ForEach-Object { $_.Matches.Value }
~~~

Expected excerpt:

~~~text
# HELP taskflow_tasks_created_total Tasks created
# TYPE taskflow_tasks_created_total counter
taskflow_tasks_created_total{application="taskflow",env="local",priority="HIGH"} 1.0
taskflow_task_title_length_characters_count{application="taskflow",env="local"} 1
taskflow_tasks_open{application="taskflow",env="local"} 7.0
http_server_requests_seconds_bucket{application="taskflow",env="local",error="none",exception="none",method="POST",outcome="SUCCESS",status="201",uri="/api/projects/{projectId}/tasks",le="0.1"} 1
~~~

And the console log now contains the correlation ids:

~~~text
2026-11-20T21:30:12.481 INFO 18324 --- [taskflow] [nio-8080-exec-3] [taskflow,6a1f0c9e2b7d4e3f8a9b0c1d2e3f4a5b,8a9b0c1d2e3f4a5b] c.e.taskflow.service.TaskService : Task created id=58 project=1
~~~

### Step 9: The observability stack in Docker Compose

~~~yaml docker-compose.yml (additions)
services:
  app:
    # ... build, ports, postgres, notification-stub from 7.3 / 8.5 ...
    environment:
      OTLP_TRACES_ENDPOINT: http://tempo:4318/v1/traces
      TRACING_SAMPLING: "1.0"
      TASKFLOW_ENV: compose

  prometheus:
    image: prom/prometheus:v3.0.1
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=7d
      - --web.enable-lifecycle
    volumes:
      - ./observability/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./observability/alerts.yml:/etc/prometheus/alerts.yml:ro
    ports:
      - "9090:9090"

  tempo:
    image: grafana/tempo:2.6.1
    command: ["-config.file=/etc/tempo.yaml"]
    volumes:
      - ./observability/tempo.yaml:/etc/tempo.yaml:ro
    ports:
      - "3200:3200"
      - "4318:4318"

  grafana:
    image: grafana/grafana:11.3.1
    environment:
      GF_SECURITY_ADMIN_PASSWORD: §{GRAFANA_PASSWORD:admin}
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
    volumes:
      - ./observability/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./observability/grafana/dashboards:/var/lib/grafana/dashboards:ro
    ports:
      - "3000:3000"
    depends_on: [prometheus, tempo]
~~~

Prefer Jaeger? Replace ^tempo^ with ^jaegertracing/all-in-one:1.62.0^ (env ^COLLECTOR_OTLP_ENABLED: "true"^, ports 16686 UI and 4318 OTLP) and point ^OTLP_TRACES_ENDPOINT^ at ^http://jaeger:4318/v1/traces^. Optional: put an ^otel/opentelemetry-collector-contrib^ container between app and backend to batch, add attributes, and tail-sample - the app then only knows the collector address, and you can switch backends without redeploying.

~~~yaml observability/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: taskflow
    metrics_path: /actuator/prometheus
    static_configs:
      - targets: ["app:8080"]
        labels:
          service: taskflow
~~~

~~~yaml observability/tempo.yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/blocks
    wal:
      path: /tmp/tempo/wal
~~~

### Step 10: Alerts based on SLOs

~~~yaml observability/alerts.yml
groups:
  - name: taskflow-slo
    rules:
      - record: taskflow:http_requests:rate5m
        expr: sum by (uri, method) (rate(http_server_requests_seconds_count{application="taskflow"}[5m]))

      - alert: TaskflowHighErrorRate
        expr: |
          sum(rate(http_server_requests_seconds_count{application="taskflow",outcome="SERVER_ERROR"}[5m]))
            / sum(rate(http_server_requests_seconds_count{application="taskflow"}[5m])) > 0.02
        for: 5m
        labels: { severity: page }
        annotations:
          summary: "TaskFlow 5xx ratio above 2% for 5 minutes"

      - alert: TaskflowCreateTaskLatencySloBurn
        expr: |
          1 - (
            sum(rate(http_server_requests_seconds_bucket{uri="/api/projects/{projectId}/tasks",method="POST",le="0.5"}[30m]))
            / sum(rate(http_server_requests_seconds_count{uri="/api/projects/{projectId}/tasks",method="POST"}[30m]))
          ) > 0.005 * 6
        for: 10m
        labels: { severity: ticket }
        annotations:
          summary: "Create-task latency SLO (99.5% under 500ms) burning 6x faster than budget"

      - alert: NotificationCircuitOpen
        expr: max(resilience4j_circuitbreaker_state{name="notification",state="open"}) == 1
        for: 2m
        labels: { severity: ticket }
        annotations:
          summary: "Email provider circuit open; notifications are being queued"

      - alert: NotificationOutboxBacklog
        expr: max(taskflow_notification_outbox_pending) > 500
        for: 15m
        labels: { severity: page }
~~~

Note how the 8.5 breaker gets a **ticket**, not a page: users are fine thanks to graceful degradation. The **backlog** pages, because that is when users start to be affected. Alert on symptoms.

### Step 11: Grafana provisioning (dashboards as code)

~~~yaml observability/grafana/provisioning/datasources/datasources.yml
apiVersion: 1
datasources:
  - name: Prometheus
    uid: prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
  - name: Tempo
    uid: tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    jsonData:
      tracesToMetrics:
        datasourceUid: prometheus
~~~

~~~yaml observability/grafana/provisioning/dashboards/dashboards.yml
apiVersion: 1
providers:
  - name: taskflow
    folder: TaskFlow
    type: file
    disableDeletion: true
    options:
      path: /var/lib/grafana/dashboards
~~~

A compact RED + business dashboard (Grafana accepts this minimal JSON; build richer panels in the UI and export them back to this file):

~~~json observability/grafana/dashboards/taskflow.json
{
  "uid": "taskflow-overview",
  "title": "TaskFlow Overview",
  "schemaVersion": 39,
  "time": { "from": "now-1h", "to": "now" },
  "refresh": "30s",
  "panels": [
    {
      "type": "timeseries", "title": "Rate (req/s) by endpoint",
      "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [ { "expr": "sum by (uri) (rate(http_server_requests_seconds_count{application=\"taskflow\"}[1m]))", "legendFormat": "{{uri}}" } ]
    },
    {
      "type": "timeseries", "title": "Errors (5xx ratio)",
      "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [ { "expr": "sum(rate(http_server_requests_seconds_count{application=\"taskflow\",outcome=\"SERVER_ERROR\"}[5m])) / sum(rate(http_server_requests_seconds_count{application=\"taskflow\"}[5m]))" } ]
    },
    {
      "type": "timeseries", "title": "Duration p95 by endpoint",
      "gridPos": { "x": 0, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [ { "expr": "histogram_quantile(0.95, sum by (le, uri) (rate(http_server_requests_seconds_bucket{application=\"taskflow\"}[5m])))", "legendFormat": "{{uri}}" } ]
    },
    {
      "type": "timeseries", "title": "Tasks created per minute by priority",
      "gridPos": { "x": 12, "y": 8, "w": 12, "h": 8 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [ { "expr": "sum by (priority) (increase(taskflow_tasks_created_total[1m]))", "legendFormat": "{{priority}}" } ]
    },
    {
      "type": "stat", "title": "Median task completion time",
      "gridPos": { "x": 0, "y": 16, "w": 8, "h": 6 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "fieldConfig": { "defaults": { "unit": "s" } },
      "targets": [ { "expr": "histogram_quantile(0.5, sum by (le) (rate(taskflow_task_completion_seconds_bucket[1d])))" } ]
    },
    {
      "type": "stat", "title": "Notification circuit open",
      "gridPos": { "x": 8, "y": 16, "w": 8, "h": 6 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [ { "expr": "max(resilience4j_circuitbreaker_state{name=\"notification\",state=\"open\"})" } ]
    },
    {
      "type": "timeseries", "title": "USE: Hikari pool active vs max",
      "gridPos": { "x": 16, "y": 16, "w": 8, "h": 6 },
      "datasource": { "type": "prometheus", "uid": "prometheus" },
      "targets": [
        { "expr": "max(hikaricp_connections_active{application=\"taskflow\"})", "legendFormat": "active" },
        { "expr": "max(hikaricp_connections_max{application=\"taskflow\"})", "legendFormat": "max" },
        { "expr": "max(hikaricp_connections_pending{application=\"taskflow\"})", "legendFormat": "pending" }
      ]
    }
  ]
}
~~~

Bring it up and explore:

~~~powershell
docker compose up -d --build
# generate some traffic with the task-create call from Step 8, then open:
# Prometheus  http://localhost:9090  (Status > Targets should show taskflow UP)
# Grafana     http://localhost:3000  (TaskFlow > TaskFlow Overview)
# Tempo via Grafana Explore: search by service.name = taskflow, or paste a traceId from the logs
~~~

In Tempo you will see a trace for ^PUT /api/tasks/1/assignee/2^ with child spans: the security filter chain, ^create-task^ or the service observation, and ^http post /v1/emails^ (the ^RestClient^ call from 8.5). WireMock received the ^traceparent^ header - check its request journal at ^http://localhost:8089/__admin/requests^ to see propagation with your own eyes.

### Step 12: Testing custom metrics

~~~java src/test/java/com/example/taskflow/metrics/TaskMetricsTest.java
package com.example.taskflow.metrics;

import com.example.taskflow.model.Priority;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.Task;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class TaskMetricsTest {

    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();
    private final TaskMetrics metrics = new TaskMetrics(registry);

    @Test
    void countsCreatedTasksByPriority() {
        Task task = new Task("Write docs", "d", Priority.HIGH, new Project("Course"));
        metrics.taskCreated(task);
        metrics.taskCreated(task);

        assertThat(registry.get("taskflow.tasks.created").tag("priority", "HIGH").counter().count())
                .isEqualTo(2.0);
    }

    @Test
    void recordsCompletionTimeFromCreation() {
        Task task = new Task("Ship", "d", Priority.LOW, new Project("Course"));
        task.setCreatedAt(Instant.now().minus(Duration.ofHours(3)));

        metrics.taskCompleted(task);

        var timer = registry.get("taskflow.task.completion").timer();
        assertThat(timer.count()).isEqualTo(1);
        assertThat(timer.totalTime(TimeUnit.HOURS)).isBetween(2.99, 3.01);
    }
}
~~~

A plain unit test with ^SimpleMeterRegistry^ is fast and exact; no Spring context needed. (It assumes the ^Task^ constructor and a ^setCreatedAt^ setter for testing; adapt to your 7.1 entity.) For integration tests, Boot disables metric export by default in tests, and ^@AutoConfigureObservability^ re-enables it when you want to assert on ^/actuator/prometheus^.

---

## 3. Common Pitfalls & Best Practices

- **Unbounded tag values.** Tagging by user id, task id or raw path explodes series count and can crash Prometheus. Fix: only bounded enums as tags; put ids in high-cardinality observation key values, traces and logs; add a ^MeterFilter^ cap.
- **Expensive gauges.** A gauge that runs SQL on each scrape slows scrapes and loads the DB. Fix: refresh a cached ^AtomicLong^ on a schedule and let the gauge read it.
- **Client-side percentiles across pods.** Averaging p95 values from several instances is mathematically wrong. Fix: publish histograms (^percentiles-histogram^) and compute ^histogram_quantile^ in PromQL.
- **Tracing 100% in production.** Full sampling multiplies cost and overhead. Fix: head-sample 5-10% via ^management.tracing.sampling.probability^ and tail-sample errors and slow traces in an OTel Collector.
- **Losing trace context on other threads.** Logs from ^@Async^, executors or ^CompletableFuture^ show empty traceId. Fix: use Boot-managed executors with context propagation (^ContextPropagatingTaskDecorator^), or wrap tasks with ^ContextSnapshot^.
- **Exposing actuator publicly.** ^/actuator/prometheus^ and ^/actuator/env^ leak internals. Fix: separate management port, network-level restriction, and ADMIN-only for everything except health and the scrape endpoint.
- **Alerting on causes instead of symptoms.** Paging on CPU 80% or an open breaker wakes people for non-issues. Fix: page on SLO burn rate and user-facing error/latency; use cause metrics on dashboards for diagnosis.
- **Self-invoking @Observed or @Timed methods.** Calls inside the same class bypass the proxy and record nothing. Fix: call through another bean or use the programmatic Observation API.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Light up the TaskFlow dashboard","tasks":["Add the dependencies, configuration, ^TaskMetrics^, ^GaugeRefresher^ and the changed ^TaskService^ methods, then confirm that ^taskflow_tasks_created_total^ and ^taskflow_task_completion_seconds_count^ appear at ^/actuator/prometheus^ after you create and complete a task.","Start the Compose stack with Prometheus, Tempo and Grafana, verify the taskflow target is UP in Prometheus, and open the provisioned TaskFlow Overview dashboard.","Create 20 tasks with mixed priorities and complete half of them; check that the Tasks created by priority panel and the open tasks gauge match what you did.","Copy a traceId from a TaskFlow log line, find the trace in Grafana Explore with the Tempo datasource, and list every span in it including the outbound ^http post^ span to the notification stub."]},
{"title":"Exercise 2 (Challenge): Observations, collector and SLOs","tasks":["Add an OpenTelemetry Collector (otel/opentelemetry-collector-contrib) between TaskFlow and Tempo with a batch processor and a tail_sampling processor that keeps all error traces and 10% of the rest. Point the app at the collector only.","Write a custom ^ObservationConvention^ for ^taskflow.report.status^ that adds a low-cardinality key value for the report size bucket (small, medium, large) and register it; prove in Prometheus that the new tag appears and ^project.id^ does not.","Define an SLO for the task assignment endpoint (99% under 1 s over 28 days) and add a multi-window burn-rate alert (1h and 5m windows) to ^alerts.yml^. Trigger it on purpose by adding a WireMock delay from lesson 8.5.","Switch logging to Boot's structured ECS JSON format and verify that traceId and spanId are separate JSON fields; then configure Grafana's Tempo datasource for traces-to-logs if you add Loki."]},
{"title":"Exercise 3 (Thinking): Telemetry design and budget","tasks":["A teammate wants to add a ^userEmail^ tag to ^taskflow.tasks.created^ to see who creates the most tasks. Explain the cost in series and memory for 50,000 users and propose two better ways to answer the same question.","Compare health checks, metrics and traces for detecting the email provider outage from lesson 8.5: which signal detects it first, which tells you the user impact, and which helps you prove the root cause?","Estimate the monthly trace volume for TaskFlow at 200 requests per second with an average of 8 spans per request at 100%, 10% and tail sampling that keeps 2% of normal plus all errors (assume 0.5% errors). Which would you choose and why?","Describe RED metrics for the TaskFlow API and USE metrics for its PostgreSQL connection pool and notification bulkhead, naming the concrete Micrometer or Resilience4j meter for each letter."]}
]
};
