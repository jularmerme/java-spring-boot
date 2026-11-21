LESSONS['8.1']={
md:String.raw`## 1. Concept & Theory

Welcome to Module 8, **Advanced Spring Boot**. In lessons 7.1-7.3 you built the **TaskFlow** capstone: a project-management API in the package ^com.example.taskflow^ with three core entities (^User^, ^Project^, ^Task^), stateless JWT security, PostgreSQL as the system of record, Flyway migrations (^V1__init.sql^), and a Docker Compose file that starts the database next to the app. Every lesson in this module extends that same codebase, so by the end you will have a capstone that looks like something a real team would run in production.

> **Where TaskFlow stands:** ^ProjectController^, ^ProjectService^, ^TaskController^, ^TaskService^, Spring Data repositories, DTO records (^ProjectResponse^, ^TaskResponse^), ^GlobalExceptionHandler^ with ProblemDetail, ^SecurityConfig^ with a JWT filter, Actuator, and ^docker-compose.yml^ with a ^postgres^ service. **This lesson adds** Redis, Spring Cache, a cached "project summary" endpoint and a Testcontainers test.

### 1.1 Why cache at all?

Imagine a busy restaurant kitchen. Every time a waiter asks "how many portions of soup are left?", the chef could walk into the cold room and count the pots. Or the chef could write the number on a whiteboard by the door and update it whenever soup is made or served. The whiteboard is a **cache**: a fast copy of an answer that is expensive to compute. The hard part is not writing on the whiteboard; the hard part is remembering to **wipe it** when the truth changes.

In TaskFlow the dashboard of every user calls ^GET /api/projects/{id}/summary^ on every page load. The summary counts tasks by status, finds overdue tasks and the next due date. That is several aggregate SQL queries over the ^tasks^ table. With 2,000 active users refreshing dashboards, PostgreSQL spends most of its CPU answering the same question again and again, even though tasks change only a few times per minute. Caching moves that repeated work out of the database:

| Without cache | With cache |
|---|---|
| Every request runs 3 aggregate queries | First request runs queries, the rest read memory |
| p95 latency 40-120 ms under load | p95 latency 1-3 ms on hit |
| DB CPU scales with traffic | DB CPU scales with writes |
| Simple, always fresh | Faster, but you must handle staleness |

Caching is a **trade-off**: you buy latency and database headroom and you pay with complexity and the risk of serving stale data. A good engineer caches deliberately, measures the hit rate, and knows exactly which writes invalidate which entries.

### 1.2 The cache-aside pattern

Spring Cache implements the most common pattern, **cache-aside** (also called lazy loading):

1. The application receives a read request and builds a key, for example ^projectSummaries::42^.
2. It asks the cache. On a **hit** it returns the cached value immediately.
3. On a **miss** it calls the real method (database), stores the result in the cache, then returns it.
4. On a write (task created, status changed, task deleted) the application **evicts** or **updates** the entry so the next read recomputes it.

The database remains the source of truth; the cache is disposable. If Redis is flushed, the app is slower for a moment but never wrong. That property is what makes cache-aside safe to adopt incrementally. Other patterns exist (write-through, write-behind, read-through), but they push more logic into the cache layer and are rarely needed for a typical REST API.

### 1.3 How Spring Cache works under the hood

Spring Cache is an **abstraction**: you annotate methods, and a provider (Caffeine, Redis, Hazelcast, a simple ^ConcurrentHashMap^) does the storage. The magic is the same AOP proxy machinery you met with ^@Transactional^:

1. ^@EnableCaching^ imports ^ProxyCachingConfiguration^, which registers a ^CacheInterceptor^ and an advisor that matches methods carrying cache annotations.
2. When Spring creates your ^ProjectSummaryService^ bean, a ^BeanPostProcessor^ notices the annotations and wraps the bean in a **CGLIB proxy** (a generated subclass).
3. Callers receive the proxy. When they call ^summarize(42L)^, the proxy asks ^CacheInterceptor^ to evaluate the annotations: compute the key, look up the ^Cache^ named ^projectSummaries^ from the ^CacheManager^, and either return the stored value or invoke your real method.
4. Spring Boot auto-configures the ^CacheManager^ (^CacheAutoConfiguration^) by detecting what is on the classpath. With ^spring-boot-starter-data-redis^ present and ^spring.cache.type=redis^, you get a ^RedisCacheManager^; with Caffeine on the classpath you get a ^CaffeineCacheManager^.

Because it is a proxy, only calls that **go through the proxy** are cached. That leads to the famous self-invocation pitfall covered in section 1.6.

### 1.4 The annotations

| Annotation | What it does | Typical use |
|---|---|---|
| ^@EnableCaching^ | Turns on the cache interceptor | Once, on a config class |
| ^@Cacheable^ | Return cached value if present, else run and store | Read methods |
| ^@CachePut^ | Always run the method, then store the result | Update methods that return the fresh value |
| ^@CacheEvict^ | Remove one entry or all entries | Delete or change operations |
| ^@Caching^ | Group several of the above on one method | A write that affects several caches |
| ^@CacheConfig^ | Class-level defaults such as cache names | Avoid repeating the name |

Important attributes: ^cacheNames^ (which cache), ^key^ (SpEL expression), ^condition^ (evaluated before the call, decides whether to cache at all), ^unless^ (evaluated after the call, can veto storing based on ^#result^), ^sync^ (only one thread computes a missing value; see stampede below) and, for eviction, ^allEntries^ and ^beforeInvocation^.

### 1.5 Keys and SpEL

If you do not specify a key, Spring uses ^SimpleKeyGenerator^: no parameters gives ^SimpleKey.EMPTY^, one parameter gives that parameter itself, several parameters give a ^SimpleKey^ wrapping all of them. That works, but it is fragile: add a parameter like ^Locale^ later and every key silently changes. In production, **write explicit keys** with SpEL:

- ^key = "#projectId"^ uses a method parameter by name (Spring Boot compiles with ^-parameters^, so names are available).
- ^key = "#request.projectId() + ':' + #request.page()"^ combines record accessors.
- ^key = "#root.methodName"^ uses the method name, rarely needed.
- ^unless = "#result == null"^ avoids caching nulls.
- ^condition = "#projectId > 0"^ skips caching for invalid input.

Note that SpEL in cache annotations uses the hash sign for variables. It never needs the placeholder syntax used for properties. If you ever do need a property placeholder elsewhere, for example in ^@Value^ or YAML, this course writes it as ^§{REDIS_HOST:localhost}^.

With Redis, the final stored key is ^cacheName::key^, e.g. ^taskflow::projectSummaries::42^ when you configure a key prefix. Keys must be **stable** (same input produces the same string every time) and **complete** (two different answers must never share a key). Forgetting a dimension is the most dangerous caching bug: if a summary depended on the current user and you cached by project id only, one user could see another user's data.

### 1.6 The self-invocation pitfall

~~~java
@Service
public class ReportService {
    public Report weekly(Long projectId) {
        return summarize(projectId); // calls 'this', NOT the proxy
    }
    @Cacheable("projectSummaries")
    public Report summarize(Long projectId) { ... }
}
~~~

^weekly()^ calls ^this.summarize()^ directly on the target object, bypassing the proxy, so the cache is never consulted. The same rule applies to ^@Transactional^ and ^@Async^. Fixes, in order of preference: move the cached method to a **separate bean** (what TaskFlow does with ^ProjectSummaryService^), or call through an injected reference to the proxy. Also remember that cache annotations on **private** methods are ignored, and that ^final^ methods cannot be overridden by CGLIB.

### 1.7 Caffeine (local) vs Redis (distributed)

| Aspect | Caffeine | Redis |
|---|---|---|
| Location | Inside the JVM heap | Separate server over the network |
| Latency | Nanoseconds | About 0.2-1 ms per round trip |
| Shared across instances | No, each pod has its own copy | Yes, all pods see the same entries |
| Survives app restart | No | Yes (until TTL or eviction) |
| Serialization | None, stores object references | Required (JSON or JDK) |
| Invalidation across pods | Hard: pod A evicts, pod B still stale | Easy: one evict is visible everywhere |
| Operational cost | Zero | Another service to run and monitor |

TaskFlow runs as several replicas behind a load balancer. If replica A evicts a summary after a task update but replica B still has its Caffeine copy, users get inconsistent dashboards depending on which pod answers. That is why we choose **Redis** for anything that must be invalidated on writes. Caffeine is excellent for data that is effectively immutable or where a few seconds of staleness per pod is fine (feature flags, reference lists like countries). Large systems often use both: a tiny Caffeine L1 in front of Redis L2.

### 1.8 Serialization: cache DTOs, not entities

Redis stores bytes, so every value must be serialized. Two rules:

- **Use JSON**, not JDK serialization. JDK serialization requires ^Serializable^, is brittle across class changes, unreadable in ^redis-cli^ and has a history of security problems.
- **Cache DTOs (records), never JPA entities.** An entity carries a Hibernate proxy, lazy collections and a persistence context. Serializing it either triggers ^LazyInitializationException^, accidentally loads half the database, or produces a detached object that someone later tries to save. A small, immutable record like ^ProjectSummaryResponse^ is safe, small and versionable.

A subtle trap: ^GenericJackson2JsonRedisSerializer^ embeds type info only for non-final types, and **records are final**. A record cached through it is often read back as a ^LinkedHashMap^, giving a ^ClassCastException^ on the second request. The robust fix is a typed ^Jackson2JsonRedisSerializer^ per cache, which is exactly what we configure below.

### 1.9 TTL, stale data and cache stampede

Every cache entry should have a **time-to-live**. Even with perfect eviction logic, a bug or a direct SQL update will someday leave a wrong value behind; a TTL bounds how long that mistake lives. Choose TTLs per cache based on how stale data may be: project summaries 10 minutes (we also evict on writes), user profile 30 minutes, reference data 24 hours.

A **cache stampede** (thundering herd) happens when a popular entry expires and hundreds of concurrent requests miss at the same moment, all hitting the database with the same query. Mitigations:

- ^@Cacheable(sync = true)^ ensures only one thread per JVM computes the value while others wait. With Redis this is per instance, not cluster-wide, but it already reduces load by the replica count factor.
- Add **jitter** to TTLs so entries do not all expire together.
- For extreme hot keys, refresh ahead of expiry in a scheduled job.

**Stale data** comes from forgotten invalidation paths. Every write that changes something a cached value depends on must evict it. List them explicitly: for project summaries, that is create task, update task, change status, delete task, and delete project.

### 1.10 What NOT to cache

- Data that changes on almost every read (counters, live stock levels): hit rate will be near zero.
- Per-request security decisions or anything that includes the caller's identity without putting the identity in the key.
- Huge objects or unbounded lists (^findAll()^): they waste memory and network bandwidth.
- Write-heavy data, where the cost of eviction exceeds the savings.
- Anything where staleness causes harm: account balances, permissions just revoked, payment state.
- Results of methods with side effects.

Rule of thumb: cache **read-heavy, expensive, tolerably stale, bounded** results, then prove it worked by measuring the hit rate.

## 2. Code Walkthrough

New and changed files in this lesson:

| File | Status |
|---|---|
| pom.xml | changed (cache, redis, testcontainers) |
| docker-compose.yml | changed (redis service) |
| src/main/resources/application.yml | changed |
| config/CacheConfig.java | new |
| dto/ProjectSummaryResponse.java | new |
| repository/TaskRepository.java | changed (aggregate queries) |
| service/ProjectSummaryService.java | new |
| service/TaskService.java | changed (evictions) |
| controller/ProjectController.java | changed (summary endpoint) |
| test/.../ProjectSummaryCachingIT.java | new |

### Step 1: Dependencies

Add the cache and Redis starters. ^spring-boot-starter-cache^ brings the abstraction; ^spring-boot-starter-data-redis^ brings Spring Data Redis and the Lettuce client. Testcontainers versions are managed by the Spring Boot parent.

~~~xml pom.xml (dependencies section, additions only)
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-cache</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>

<!-- tests -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>postgresql</artifactId>
    <scope>test</scope>
</dependency>
~~~

### Step 2: Redis in Docker Compose

~~~yaml docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: taskflow
      POSTGRES_USER: taskflow
      POSTGRES_PASSWORD: §{DB_PASSWORD:-taskflow}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskflow"]
      interval: 5s
      retries: 10

  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 10

  app:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      SPRING_PROFILES_ACTIVE: prod
      DB_URL: jdbc:postgresql://postgres:5432/taskflow
      DB_PASSWORD: §{DB_PASSWORD:-taskflow}
      REDIS_HOST: redis
      JWT_SECRET: §{JWT_SECRET}
    ports:
      - "8080:8080"

volumes:
  pgdata:
~~~

^maxmemory^ plus ^allkeys-lru^ turns Redis into a proper cache: when memory is full it evicts the least recently used keys instead of rejecting writes. Without a memory limit, a cache can grow until the container is killed.

### Step 3: Configuration

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: taskflow
  datasource:
    url: §{DB_URL:jdbc:postgresql://localhost:5432/taskflow}
    username: taskflow
    password: §{DB_PASSWORD:taskflow}
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
  flyway:
    enabled: true
  data:
    redis:
      host: §{REDIS_HOST:localhost}
      port: 6379
      timeout: 500ms
  cache:
    type: redis
    cache-names: projectSummaries,userProfiles
    redis:
      time-to-live: 10m
      key-prefix: "taskflow::"
      use-key-prefix: true
      cache-null-values: false
      enable-statistics: true

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,caches,prometheus

taskflow:
  jwt:
    secret: §{JWT_SECRET:change-me-in-dev-only-change-me-in-dev-only}
~~~

^enable-statistics: true^ is essential: without it, Redis caches do not record hits and misses and Actuator metrics show nothing. The short ^timeout^ matters too: if Redis is slow, you want a fast failure rather than threads piling up.

### Step 4: The DTO we cache

~~~java src/main/java/com/example/taskflow/dto/ProjectSummaryResponse.java
package com.example.taskflow.dto;

import java.time.Instant;
import java.time.LocalDate;

public record ProjectSummaryResponse(
        Long projectId,
        String projectName,
        long totalTasks,
        long todo,
        long inProgress,
        long done,
        long overdue,
        LocalDate nextDueDate,
        Instant generatedAt
) {
    public int completionPercent() {
        return totalTasks == 0 ? 0 : (int) Math.round(done * 100.0 / totalTasks);
    }
}
~~~

^generatedAt^ is handy while learning: if it does not change between two requests, you are seeing a cached value.

### Step 5: Cache configuration with per-cache TTL and JSON

~~~java src/main/java/com/example/taskflow/config/CacheConfig.java
package com.example.taskflow.config;

import com.example.taskflow.dto.ProjectSummaryResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.springframework.boot.autoconfigure.cache.RedisCacheManagerBuilderCustomizer;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.cache.RedisCacheConfiguration;
import org.springframework.data.redis.serializer.Jackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.RedisSerializationContext.SerializationPair;
import org.springframework.data.redis.serializer.StringRedisSerializer;

import java.time.Duration;

@Configuration
@EnableCaching
public class CacheConfig {

    public static final String PROJECT_SUMMARIES = "projectSummaries";
    public static final String USER_PROFILES = "userProfiles";

    private static ObjectMapper cacheObjectMapper() {
        // A dedicated mapper: changes to the web ObjectMapper never break cached data.
        return new ObjectMapper()
                .registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    private static <T> RedisCacheConfiguration jsonConfig(Class<T> type, Duration ttl) {
        var valueSerializer = new Jackson2JsonRedisSerializer<>(cacheObjectMapper(), type);
        return RedisCacheConfiguration.defaultCacheConfig()
                .entryTtl(ttl)
                .disableCachingNullValues()
                .prefixCacheNameWith("taskflow::")
                .serializeKeysWith(SerializationPair.fromSerializer(new StringRedisSerializer()))
                .serializeValuesWith(SerializationPair.fromSerializer(valueSerializer));
    }

    @Bean
    RedisCacheManagerBuilderCustomizer taskflowCacheCustomizer() {
        return builder -> builder
                .withCacheConfiguration(PROJECT_SUMMARIES,
                        jsonConfig(ProjectSummaryResponse.class, Duration.ofMinutes(10)))
                .withCacheConfiguration(USER_PROFILES,
                        jsonConfig(com.example.taskflow.dto.UserResponse.class, Duration.ofMinutes(30)))
                .enableStatistics();
    }
}
~~~

What is happening: Spring Boot's ^RedisCacheConfiguration^ auto-configuration builds a ^RedisCacheManager.RedisCacheManagerBuilder^ from the properties in ^application.yml^ and then applies every ^RedisCacheManagerBuilderCustomizer^ bean. We keep Boot's defaults (connection, statistics, default TTL) and override the two named caches with a **typed JSON serializer** and an individual TTL. Because each cache knows its exact value type, records deserialize correctly without polymorphic type metadata in the JSON, and the stored values stay human-readable. ^UserResponse^ is the existing record from lesson 7.2.

### Step 6: Aggregate queries in the repository

~~~java src/main/java/com/example/taskflow/repository/TaskRepository.java
package com.example.taskflow.repository;

import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface TaskRepository extends JpaRepository<Task, Long> {

    Page<Task> findByProjectId(Long projectId, Pageable pageable);

    interface StatusCount {
        TaskStatus getStatus();
        long getCount();
    }

    @Query("""
           select t.status as status, count(t) as count
           from Task t
           where t.project.id = :projectId
           group by t.status
           """)
    List<StatusCount> countByStatus(@Param("projectId") Long projectId);

    @Query("""
           select count(t) from Task t
           where t.project.id = :projectId
             and t.status <> com.example.taskflow.model.TaskStatus.DONE
             and t.dueDate < :today
           """)
    long countOverdue(@Param("projectId") Long projectId, @Param("today") LocalDate today);

    @Query("""
           select min(t.dueDate) from Task t
           where t.project.id = :projectId
             and t.status <> com.example.taskflow.model.TaskStatus.DONE
             and t.dueDate >= :today
           """)
    Optional<LocalDate> findNextDueDate(@Param("projectId") Long projectId, @Param("today") LocalDate today);
}
~~~

### Step 7: The cached service

~~~java src/main/java/com/example/taskflow/service/ProjectSummaryService.java
package com.example.taskflow.service;

import com.example.taskflow.config.CacheConfig;
import com.example.taskflow.dto.ProjectSummaryResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.TaskRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.EnumMap;
import java.util.Map;

@Service
public class ProjectSummaryService {

    private static final Logger log = LoggerFactory.getLogger(ProjectSummaryService.class);

    private final ProjectRepository projectRepository;
    private final TaskRepository taskRepository;
    private final Clock clock;

    public ProjectSummaryService(ProjectRepository projectRepository,
                                 TaskRepository taskRepository,
                                 Clock clock) {
        this.projectRepository = projectRepository;
        this.taskRepository = taskRepository;
        this.clock = clock;
    }

    @Cacheable(cacheNames = CacheConfig.PROJECT_SUMMARIES, key = "#projectId", sync = true)
    @Transactional(readOnly = true)
    public ProjectSummaryResponse summarize(Long projectId) {
        log.info("Cache miss: computing summary for project {}", projectId);
        Project project = projectRepository.findById(projectId)
                .orElseThrow(() -> new ResourceNotFoundException("Project", projectId));

        Map<TaskStatus, Long> counts = new EnumMap<>(TaskStatus.class);
        taskRepository.countByStatus(projectId)
                .forEach(c -> counts.put(c.getStatus(), c.getCount()));

        LocalDate today = LocalDate.now(clock);
        long todo = counts.getOrDefault(TaskStatus.TODO, 0L);
        long inProgress = counts.getOrDefault(TaskStatus.IN_PROGRESS, 0L);
        long done = counts.getOrDefault(TaskStatus.DONE, 0L);

        return new ProjectSummaryResponse(
                project.getId(),
                project.getName(),
                todo + inProgress + done,
                todo, inProgress, done,
                taskRepository.countOverdue(projectId, today),
                taskRepository.findNextDueDate(projectId, today).orElse(null),
                Instant.now(clock));
    }

    @CacheEvict(cacheNames = CacheConfig.PROJECT_SUMMARIES, key = "#projectId")
    public void evict(Long projectId) {
        log.debug("Evicted summary for project {}", projectId);
    }
}
~~~

Notes on the design:

- ^sync = true^ protects against stampedes inside one JVM. It cannot be combined with ^unless^, which is fine because we never return null (a missing project throws, and exceptions are never cached).
- The ^Clock^ bean (from lesson 7.2's ^TimeConfig^; if you do not have one, add ^@Bean Clock clock() { return Clock.systemUTC(); }^) makes the summary testable.
- The eviction method lives in **the same bean as the cached method but is called from another bean** (^TaskService^), so both calls pass through the proxy. Putting ^summarize()^ inside ^ProjectService^ and calling it from another method of ^ProjectService^ would hit the self-invocation pitfall.
- Authorization is **not** part of the cached method. The controller checks that the caller is a member of the project first, so the cached value can be shared safely by all members.

### Step 8: Evict on every write

~~~java src/main/java/com/example/taskflow/service/TaskService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskRequest;
import com.example.taskflow.dto.TaskResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.TaskRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

@Service
public class TaskService {

    private final TaskRepository taskRepository;
    private final ProjectRepository projectRepository;
    private final ProjectSummaryService summaryService;

    public TaskService(TaskRepository taskRepository,
                       ProjectRepository projectRepository,
                       ProjectSummaryService summaryService) {
        this.taskRepository = taskRepository;
        this.projectRepository = projectRepository;
        this.summaryService = summaryService;
    }

    @Transactional
    public TaskResponse create(Long projectId, TaskRequest request) {
        Project project = projectRepository.findById(projectId)
                .orElseThrow(() -> new ResourceNotFoundException("Project", projectId));
        Task task = new Task(request.title(), request.description(), request.dueDate(), project);
        Task saved = taskRepository.save(task);
        evictAfterCommit(projectId);
        return TaskResponse.from(saved);
    }

    @Transactional
    public TaskResponse changeStatus(Long taskId, TaskStatus status) {
        Task task = findTask(taskId);
        task.setStatus(status);
        evictAfterCommit(task.getProject().getId());
        return TaskResponse.from(task);
    }

    @Transactional
    public void delete(Long taskId) {
        Task task = findTask(taskId);
        Long projectId = task.getProject().getId();
        taskRepository.delete(task);
        evictAfterCommit(projectId);
    }

    private Task findTask(Long taskId) {
        return taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
    }

    /**
     * Evict only after the DB transaction commits. Evicting earlier opens a race:
     * another request could re-cache the OLD data before our commit becomes visible.
     */
    private void evictAfterCommit(Long projectId) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                summaryService.evict(projectId);
            }
        });
    }
}
~~~

This is a production detail most tutorials skip. If you put ^@CacheEvict^ directly on the ^@Transactional^ method, the eviction may happen before the commit. Between eviction and commit, a concurrent reader misses, reads the **old** rows (the new ones are not committed yet) and caches stale data for the full TTL. Evicting in ^afterCommit()^ closes that window. An alternative is ^RedisCacheManager^'s ^transactionAware()^ option, which defers cache writes and evictions until commit for all caches.

For update methods that return the complete new value, ^@CachePut^ is the right tool, for example a profile update:

~~~java src/main/java/com/example/taskflow/service/UserProfileService.java
package com.example.taskflow.service;

import com.example.taskflow.config.CacheConfig;
import com.example.taskflow.dto.UpdateProfileRequest;
import com.example.taskflow.dto.UserResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.User;
import com.example.taskflow.repository.UserRepository;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.CachePut;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.cache.annotation.Caching;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserProfileService {

    private final UserRepository userRepository;

    public UserProfileService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Cacheable(cacheNames = CacheConfig.USER_PROFILES, key = "#userId")
    @Transactional(readOnly = true)
    public UserResponse getProfile(Long userId) {
        return UserResponse.from(find(userId));
    }

    @CachePut(cacheNames = CacheConfig.USER_PROFILES, key = "#userId")
    @Transactional
    public UserResponse updateProfile(Long userId, UpdateProfileRequest request) {
        User user = find(userId);
        user.setDisplayName(request.displayName());
        return UserResponse.from(user);
    }

    @Caching(evict = {
            @CacheEvict(cacheNames = CacheConfig.USER_PROFILES, key = "#userId"),
            @CacheEvict(cacheNames = CacheConfig.PROJECT_SUMMARIES, allEntries = true)
    })
    @Transactional
    public void deleteUser(Long userId) {
        userRepository.delete(find(userId));
    }

    private User find(Long userId) {
        return userRepository.findById(userId)
                .orElseThrow(() -> new ResourceNotFoundException("User", userId));
    }
}
~~~

^allEntries = true^ is a blunt instrument: with Redis it runs a ^SCAN^ plus delete over all matching keys. Use it rarely, for operations that touch an unknown set of entries.

### Step 9: The endpoint

~~~java src/main/java/com/example/taskflow/controller/ProjectController.java (added method)
@GetMapping("/{id}/summary")
public ProjectSummaryResponse summary(@PathVariable Long id,
                                      @AuthenticationPrincipal Jwt jwt) {
    projectService.assertMember(id, jwt.getSubject()); // 403 if not a member, 404 if missing
    return summaryService.summarize(id);
}
~~~

Inject ^ProjectSummaryService summaryService^ through the existing constructor. ^assertMember^ is the membership check from lesson 7.3.

### Step 10: Run and observe

~~~powershell
docker compose up -d postgres redis
./mvnw spring-boot:run

$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body '{"email":"julian@example.com","password":"Secret123!"}').token
$h = @{ Authorization = "Bearer $token" }

Measure-Command { Invoke-RestMethod http://localhost:8080/api/projects/1/summary -Headers $h }
Measure-Command { Invoke-RestMethod http://localhost:8080/api/projects/1/summary -Headers $h }
~~~

The first call logs ^Cache miss: computing summary for project 1^ and takes tens of milliseconds; the second does not log and is much faster, with the same ^generatedAt^. Now inspect Redis:

~~~text
> docker compose exec redis redis-cli
127.0.0.1:6379> SCAN 0 MATCH taskflow::* COUNT 100
1) "0"
2) 1) "taskflow::projectSummaries::1"
127.0.0.1:6379> GET taskflow::projectSummaries::1
"{\"projectId\":1,\"projectName\":\"Website relaunch\",\"totalTasks\":12,\"todo\":5,\"inProgress\":4,\"done\":3,\"overdue\":1,\"nextDueDate\":\"2026-11-24\",\"generatedAt\":\"2026-11-20T21:10:03.512Z\"}"
127.0.0.1:6379> TTL taskflow::projectSummaries::1
(integer) 587
127.0.0.1:6379> INFO stats
keyspace_hits:14
keyspace_misses:3
~~~

Never use ^KEYS *^ in production: it blocks the single-threaded Redis server while it walks every key. ^SCAN^ is incremental. Now change a task status (^PATCH /api/tasks/5/status^) and run ^GET^ again in redis-cli: the key is gone, and the next summary request recomputes.

### Step 11: Measure the hit rate with Actuator

Boot binds every cache to Micrometer as ^cache.gets^, ^cache.puts^ and ^cache.evictions^ with tags ^name^ and ^result^.

~~~text
GET /actuator/caches
{"cacheManagers":{"cacheManager":{"caches":{"projectSummaries":{"target":"org.springframework.data.redis.cache.DefaultRedisCacheWriter"},"userProfiles":{...}}}}}

GET /actuator/metrics/cache.gets?tag=name:projectSummaries&tag=result:hit
{"name":"cache.gets","measurements":[{"statistic":"COUNT","value":118.0}], ...}

GET /actuator/metrics/cache.gets?tag=name:projectSummaries&tag=result:miss
{"name":"cache.gets","measurements":[{"statistic":"COUNT","value":9.0}], ...}
~~~

Hit rate = hits / (hits + misses) = 118 / 127, about 93 percent. In Grafana with Prometheus you would plot the rate of hits divided by the rate of all gets. A cache with a hit rate below roughly 50 percent is usually costing more than it saves. Remember to secure Actuator: only ^health^ should be public; ^metrics^ and ^caches^ belong behind an admin role, as configured in 7.3.

### Step 12: Caffeine as a local alternative

For a single-instance deployment or for immutable reference data, add ^com.github.ben-manes.caffeine:caffeine^ and switch in a profile:

~~~yaml src/main/resources/application-local-cache.yml
spring:
  cache:
    type: caffeine
    cache-names: projectSummaries,userProfiles
    caffeine:
      spec: maximumSize=10000,expireAfterWrite=10m,recordStats
~~~

^recordStats^ plays the role of ^enable-statistics^. Everything else, including your annotations, stays the same. That is the payoff of the abstraction: the provider is a deployment decision, not a code change.

### Step 13: Integration test with Testcontainers Redis

~~~java src/test/java/com/example/taskflow/service/ProjectSummaryCachingIT.java
package com.example.taskflow.service;

import com.example.taskflow.config.CacheConfig;
import com.example.taskflow.dto.ProjectSummaryResponse;
import com.example.taskflow.dto.TaskRequest;
import com.example.taskflow.model.Project;
import com.example.taskflow.model.TaskStatus;
import com.example.taskflow.model.User;
import com.example.taskflow.repository.ProjectRepository;
import com.example.taskflow.repository.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.cache.CacheManager;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDate;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@Testcontainers
class ProjectSummaryCachingIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Container
    @ServiceConnection(name = "redis")
    static GenericContainer<?> redis = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    @Autowired ProjectSummaryService summaryService;
    @Autowired TaskService taskService;
    @Autowired ProjectRepository projectRepository;
    @Autowired UserRepository userRepository;
    @Autowired CacheManager cacheManager;
    @Autowired StringRedisTemplate redisTemplate;

    @Test
    void secondCallIsServedFromRedisAndWriteEvicts() {
        User owner = userRepository.save(new User("cache@test.dev", "Cache Tester", "{noop}pw"));
        Project project = projectRepository.save(new Project("Cache project", owner));
        Long id = project.getId();

        ProjectSummaryResponse first = summaryService.summarize(id);
        ProjectSummaryResponse second = summaryService.summarize(id);

        // same generatedAt proves the method body did not run again
        assertThat(second.generatedAt()).isEqualTo(first.generatedAt());
        assertThat(redisTemplate.hasKey("taskflow::projectSummaries::" + id)).isTrue();
        assertThat(cacheManager.getCache(CacheConfig.PROJECT_SUMMARIES).get(id, ProjectSummaryResponse.class))
                .isEqualTo(first);

        taskService.create(id, new TaskRequest("Write tests", "with Redis", LocalDate.now().plusDays(3)));

        assertThat(redisTemplate.hasKey("taskflow::projectSummaries::" + id)).isFalse();
        ProjectSummaryResponse third = summaryService.summarize(id);
        assertThat(third.totalTasks()).isEqualTo(1);
        assertThat(third.todo()).isEqualTo(1);
    }
}
~~~

^@ServiceConnection(name = "redis")^ tells Spring Boot that this generic container is a Redis server, so it creates the ^RedisConnectionDetails^ (host and mapped port) automatically; no ^@DynamicPropertySource^ is needed. The test also proves a crucial point the unit tests could not: the value survives a real JSON round trip through Redis and comes back as an equal record. If you had used the wrong serializer, the ^get(id, ProjectSummaryResponse.class)^ line would fail. Run it with ^./mvnw verify^ (Docker must be running). Note that the ^create^ call is not inside a test transaction, so ^afterCommit^ fires and the eviction is observable.

## 3. Common Pitfalls & Best Practices

- **Self-invocation:** calling a ^@Cacheable^ method from the same class bypasses the proxy, so nothing is cached. Fix: put cached methods in a dedicated bean and call them from outside.
- **Caching entities:** serializing JPA entities drags lazy proxies and session state into Redis. Fix: cache small immutable records built inside a read-only transaction.
- **Wrong serializer for records:** a generic JSON serializer without type info returns ^LinkedHashMap^ and causes ^ClassCastException^. Fix: typed ^Jackson2JsonRedisSerializer^ per cache, and an integration test that round-trips through real Redis.
- **Incomplete keys:** caching by project id when the result depends on the user leaks data across users. Fix: authorize outside the cached method, or include every input dimension in the SpEL key.
- **Evicting before commit:** a concurrent read re-caches old data. Fix: evict in ^afterCommit()^ or use a transaction-aware cache manager.
- **No TTL, no memory limit:** a bug leaves stale data forever and Redis grows until it dies. Fix: per-cache ^entryTtl^ plus ^maxmemory^ with ^allkeys-lru^.
- **Using KEYS in production or flushing everything on writes:** both hurt the whole cluster. Fix: ^SCAN^ for inspection and targeted evictions by key.
- **Flying blind:** without statistics you cannot tell whether a cache helps. Fix: ^enable-statistics^, watch ^cache.gets^ by result, and remove caches whose hit rate stays low.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Cache the project member list","tasks":["Create a record ^ProjectMemberResponse^ (userId, displayName, role) and a method ^listMembers(Long projectId)^ in a new ^ProjectMemberService^ annotated with ^@Cacheable^ on a new cache named ^projectMembers^.","Register the cache in ^CacheConfig^ with a typed JSON serializer for a list of members (hint: use a wrapper record such as ^ProjectMembers(List<ProjectMemberResponse> members)^) and a TTL of 15 minutes.","Evict the entry after commit whenever a member is added or removed, reusing the ^afterCommit^ technique from ^TaskService^.","Call the endpoint twice, then use ^redis-cli^ with ^SCAN^, ^GET^ and ^TTL^ to show the key, its JSON value and remaining lifetime.","Report the hit and miss counts from ^/actuator/metrics/cache.gets^ for ^projectMembers^ after ten requests and one membership change."]},
{"title":"Exercise 2 (Challenge): Two-level cache and stampede protection","tasks":["Read the Spring Framework reference section on cache abstraction and the Spring Data Redis section on ^RedisCacheManager^, then write three sentences explaining what ^transactionAware()^ changes.","Add random jitter of up to 20 percent to the TTL of ^projectSummaries^ (hint: look at ^RedisCacheWriter.TtlFunction^ and ^RedisCacheConfiguration.entryTtl^ overloads).","Write a load test (a JUnit test with 50 virtual threads via ^Executors.newVirtualThreadPerTaskExecutor()^) that requests one uncached summary concurrently, and count how many times the cache-miss log line appears with ^sync = true^ and with ^sync = false^.","Design (in code or prose) a small Caffeine L1 cache in front of Redis for ^userProfiles^, and explain how you would invalidate L1 on other replicas (hint: Redis pub/sub).","Extend ^ProjectSummaryCachingIT^ so it fails if the cached value cannot be deserialized back into ^ProjectSummaryResponse^."]},
{"title":"Exercise 3 (Thinking): Should this be cached?","tasks":["For each of these TaskFlow reads decide cache or no cache and justify with read/write ratio, cost and staleness tolerance: the JWT public key, a user's unread notification count, the list of task statuses, a full-text task search, and a project's activity feed.","Explain in your own words why caching ^ProjectSummaryResponse^ by project id is safe in TaskFlow but would be unsafe if the summary contained 'tasks assigned to me'. Propose a correct key.","Describe what happens to TaskFlow when Redis is down. Research ^CacheErrorHandler^ and sketch how you would make cache failures degrade to database reads instead of HTTP 500 errors.","A teammate suggests caching every repository method 'to be fast'. Write a short review comment listing at least four risks."]}
]
};
