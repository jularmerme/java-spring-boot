LESSONS['8.5']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** After lessons 7.1-7.3 TaskFlow (base package ^com.example.taskflow^) is a layered Spring Boot 3.4 application on Java 21 with the entities **User**, **Project** and **Task**, stateless JWT security, PostgreSQL with Flyway migrations, and a Docker Compose file that starts the app plus the database. In this lesson TaskFlow gets its first real **outbound dependency**: when a task is assigned, TaskFlow calls an external **notification service** over HTTP to send an email. That one HTTP call is enough to bring every classic distributed-systems failure mode into our codebase, so we will make it resilient.

**New files:** ^NotificationProperties^, ^NotificationClientConfig^, ^NotificationClient^, ^NotificationRequest^, ^NotificationResult^, ^NotificationService^, ^OutboxNotification^ entity + repository + Flyway migration ^V7__notification_outbox.sql^, ^NotificationCircuitBreakerIT^, ^NotificationRetryTest^. **Changed files:** ^pom.xml^, ^application.yml^, ^TaskService^ (assignment now triggers a notification), ^docker-compose.yml^ (a WireMock container that pretends to be the email provider).

### 1.1 Why remote calls are different

Inside a single JVM a method call either returns or throws, almost instantly. Across a network a call can do something far worse: **nothing**. Peter Deutsch's "fallacies of distributed computing" begin with "the network is reliable" and "latency is zero" - both false. In production you will see:

| Failure mode | What you observe | Why it is dangerous |
|---|---|---|
| Connection refused | Immediate exception | Cheap; fail fast is easy |
| Slow connect (SYN lost, firewall drop) | Thread blocks for seconds | Ties up a request thread |
| Slow response (dependency overloaded, GC pause) | Thread blocks until read timeout | Threads pile up, pool exhausted |
| Partial failure (5xx for 20% of calls) | Intermittent errors | Users see random failures |
| Throttling (HTTP 429) | Provider rejects excess load | Retrying blindly makes it worse |
| Ambiguous outcome (timeout after request sent) | You do not know if it happened | Retrying may duplicate side effects |

The killer is the slow call. Imagine Tomcat with 200 worker threads. The email provider starts answering in 30 seconds instead of 200 ms. Each task assignment now holds a thread for 30 seconds; at 10 requests per second the whole pool is gone in 20 seconds, and **every** TaskFlow endpoint - even ^GET /api/projects^, which never touches email - stops responding. That is a **cascading failure**: a problem in a non-critical dependency takes down the critical system, and then services calling TaskFlow fail the same way. Resilience engineering is about drawing **firebreaks** so that failures stay local.

Real-world analogy: a restaurant kitchen. If the dessert supplier is late, a good kitchen does not stop cooking main courses while every cook waits at the back door. It sets a deadline (timeout), tries again later (retry), stops calling a supplier that is clearly down (circuit breaker), assigns only one cook to deal with suppliers (bulkhead), and tells guests "no tiramisu tonight" (fallback / graceful degradation).

### 1.2 The resilience toolbox, in the order you should apply it

| Pattern | Question it answers | Resilience4j module |
|---|---|---|
| Timeout | How long am I willing to wait? | HTTP client config, TimeLimiter |
| Retry | Is this failure transient enough to try again? | Retry |
| Circuit breaker | Is the dependency so broken that I should stop calling it? | CircuitBreaker |
| Bulkhead | How many of my threads may this dependency hold? | Bulkhead |
| Rate limiter | How many calls per period am I allowed to make? | RateLimiter |
| Fallback | What do I do instead when all of that fails? | fallbackMethod |

**Timeouts first, always.** Every other pattern assumes calls finish. A retry without a timeout just waits forever three times. A circuit breaker counts failures, but a call that never returns is never counted. The single most valuable resilience change in most codebases is adding explicit connect and read timeouts to every HTTP client.

- **Connect timeout**: max time to establish TCP (and TLS) connection. Keep it short (1-2 s); a healthy service in the same region connects in milliseconds.
- **Read (response) timeout**: max time waiting for the response after sending the request. Derive it from the dependency's p99 latency plus margin, and from your own latency budget: if TaskFlow promises a 2 s response, a 10 s read timeout on a downstream call is a lie.

Under the hood, Spring's ^RestClient^ delegates to a ^ClientHttpRequestFactory^. With ^JdkClientHttpRequestFactory^ the connect timeout is configured on the JDK ^HttpClient^ builder and the read timeout on the factory (it becomes the per-request timeout of the JDK client). Spring Boot 3.4 also introduced ^ClientHttpRequestFactorySettings^ / ^ClientHttpRequestFactoryBuilder^ and the properties ^spring.http.client.connect-timeout^ and ^spring.http.client.read-timeout^, which apply to auto-configured ^RestClient.Builder^ beans. We will configure timeouts explicitly per client, because different dependencies deserve different budgets.

### 1.3 Retry: useful, and dangerous

A retry is a bet that the failure is **transient**: a dropped connection, a pod being restarted, a 503 during a deployment. Good retry policy:

- Retry only **retryable** errors: I/O exceptions, timeouts, 502/503/504, 429 (respecting Retry-After). Never retry 400, 401, 403, 404, 422 - they will fail identically.
- Use **exponential backoff**: wait 200 ms, 400 ms, 800 ms... giving the dependency time to recover.
- Add **jitter** (randomization). Without it, 1,000 clients that failed at the same instant all retry at the same instant - a thundering herd that knocks the recovering service down again.
- Cap attempts (3 is typical) and the total time.

When retries are dangerous:

1. **Non-idempotent calls.** "Send email" or "charge card" is not idempotent. If the read timeout fires after the provider already sent the email, a retry sends it twice. The fix is an **idempotency key**: a unique ID per logical operation, sent as a header (^Idempotency-Key^), which the provider uses to deduplicate. Stripe, Adyen and most email APIs support this.
2. **Retry storms.** If service A retries 3 times calling B, and B retries 3 times calling C, a single failure in C becomes 9 calls; with 4 layers, 81. Retry at **one** layer (usually the closest to the user or the closest to the failing dependency), not every layer.
3. **Retrying while overloaded.** If the dependency fails because it is overloaded, retries add load exactly when it hurts most. That is why retry is paired with a circuit breaker.

### 1.4 Circuit breaker: the three states

A circuit breaker wraps calls and tracks outcomes in a **sliding window**.

| State | Behaviour | Transition |
|---|---|---|
| CLOSED | Calls pass through; outcomes recorded | To OPEN when failure rate or slow-call rate exceeds threshold (after minimumNumberOfCalls) |
| OPEN | Calls rejected immediately with ^CallNotPermittedException^ | To HALF_OPEN after waitDurationInOpenState |
| HALF_OPEN | A limited number of trial calls allowed | To CLOSED if trials succeed; back to OPEN if they fail |

Key configuration:

| Property | Meaning | TaskFlow value |
|---|---|---|
| slidingWindowType | COUNT_BASED (last N calls) or TIME_BASED (last N seconds) | COUNT_BASED |
| slidingWindowSize | N calls or N seconds | 10 |
| minimumNumberOfCalls | Calls needed before the rate is evaluated | 5 |
| failureRateThreshold | Percent failures that opens the breaker | 50 |
| slowCallDurationThreshold | A call slower than this is "slow" | 2s |
| slowCallRateThreshold | Percent slow calls that opens the breaker | 80 |
| waitDurationInOpenState | Time to stay OPEN before probing | 10s |
| permittedNumberOfCallsInHalfOpenState | Trial calls in HALF_OPEN | 3 |
| automaticTransitionFromOpenToHalfOpenEnabled | Move to HALF_OPEN by timer rather than on next call | true |
| recordExceptions / ignoreExceptions | Which exceptions count as failures | I/O + 5xx recorded, 4xx ignored |

Why it helps: an OPEN breaker fails in microseconds instead of 2 seconds, so threads are freed, the dependency gets breathing room to recover, and your fallback runs immediately. It turns "slow failure" into "fast failure", which is the essence of stopping a cascade.

### 1.5 Bulkhead, rate limiter, time limiter

- **Bulkhead** (ship compartments): limits concurrent calls to one dependency. A ^SemaphoreBulkhead^ with ^maxConcurrentCalls: 10^ means at most 10 Tomcat threads may be inside the notification call; the 11th waits up to ^maxWaitDuration^ and then gets ^BulkheadFullException^. Even if email is slow, 190 threads remain for everything else. With Java 21 virtual threads, thread exhaustion is less of an issue, but bulkheads still protect the **dependency** and your connection pool.
- **Rate limiter**: limits calls per refresh period (e.g. 20 per second), typically to respect a provider's quota or protect yourself from a noisy client. Calls over the limit wait up to ^timeoutDuration^ then fail with ^RequestNotPermitted^.
- **Time limiter**: puts a timeout on **asynchronous** calls (^CompletableFuture^). For blocking ^RestClient^ calls the HTTP client timeouts are the correct tool; the time limiter cannot interrupt a blocked socket read reliably.

**Load shedding** is the server-side cousin: when TaskFlow itself is overloaded it should reject excess requests early with 503 or 429 (cheap) instead of accepting them and timing out (expensive). A rate limiter or bulkhead on incoming endpoints is a simple form of load shedding; more advanced systems shed by priority (keep "create task", drop "export report").

### 1.6 Fallbacks and graceful degradation

A fallback is what happens when the protected call fails or is rejected. Good fallbacks for TaskFlow's email:

- **Queue it**: store the notification in an **outbox** table and let a scheduled job retry later. The user's task assignment succeeds; the email is delayed, not lost.
- **Degrade**: return a response flag ^notificationQueued: true^ so the UI can say "assignee will be notified shortly".

Bad fallbacks: silently swallowing the error (data loss), or a fallback that calls another remote service with no protection (you just moved the problem). The guiding question: **is this dependency critical to the user's request?** Email is not; creating the task is. So the task must never fail because email failed.

### 1.7 Magic under the hood: how resilience4j-spring-boot3 works

The ^resilience4j-spring-boot3^ starter registers ^CircuitBreakerRegistry^, ^RetryRegistry^, ^BulkheadRegistry^, ^RateLimiterRegistry^ and ^TimeLimiterRegistry^ beans, built from ^resilience4j.*^ properties. It also registers **AOP aspects** (it requires ^spring-boot-starter-aop^). When Spring creates the ^NotificationClient^ bean and finds ^@CircuitBreaker(name = "notification")^, it wraps the bean in a proxy. Calling the method on the proxy runs the aspect chain, which decorates the real call with the named instance.

Consequences you must know:

- **Self-invocation bypasses the proxy.** Calling an annotated method from another method of the same class (^this.send()^) skips all resilience logic. Put annotated methods in a separate bean.
- **Aspect order.** When several annotations are on one method, Resilience4j applies them in a fixed default order, outermost to innermost: **Retry ( CircuitBreaker ( RateLimiter ( TimeLimiter ( Bulkhead ( call ) ) ) ) )**. So Retry is outermost: each retry attempt passes through the circuit breaker and is recorded individually. That is usually what you want: if the breaker opens mid-retry, the next attempt fails fast with ^CallNotPermittedException^ (which you should configure Retry to ignore). You can change the order with ^resilience4j.retry.retryAspectOrder^ and ^resilience4j.circuitbreaker.circuitBreakerAspectOrder^ (higher value = higher priority = outer), but change it only with a clear reason.
- **Fallback signature.** ^fallbackMethod^ must be in the same class, have the same parameters plus a trailing ^Throwable^ (or a more specific exception), and the same return type. The most specific matching exception type wins. A typo in the name fails at call time, not startup - test it.

### 1.8 The Spring Framework 7 / Spring Retry alternative (honest version note)

For years the option was the separate **Spring Retry** project (^@EnableRetry^, ^@Retryable^, ^@Recover^), now in maintenance mode. **Spring Framework 7.0** (shipped with Spring Boot 4.0, November 2025) brought resilience features into the core: ^@Retryable^ (with ^maxRetries^, ^delay^, ^multiplier^, ^jitter^, also for reactive return types), ^@ConcurrencyLimit^ (a bulkhead-like throttle), ^@EnableResilientMethods^, and a programmatic ^RetryTemplate^ in ^org.springframework.core.retry^. These were sometimes discussed as "6.2" features in early previews, but they are **not** in Spring Framework 6.2 - Boot 3.4/3.5 users (like TaskFlow) do not have them. Core Spring also has **no circuit breaker**. So: on Boot 3.x use Resilience4j; on Boot 4.x you can use the native annotations for simple retry/concurrency needs and keep Resilience4j for circuit breakers, rate limiters, and rich metrics.

~~~java Spring Framework 7 / Boot 4 only - shown for comparison, NOT used in TaskFlow
@Configuration
@EnableResilientMethods
class ResilienceConfig { }

@Service
class PingClient {
    @Retryable(includes = IOException.class, maxRetries = 3, delay = 200, multiplier = 2, jitter = 50)
    @ConcurrencyLimit(10)
    public String ping() { /* remote call */ return "ok"; }
}
~~~

---

## 2. Code Walkthrough

### Step 1: Dependencies

~~~xml pom.xml (dependencies section - additions)
<!-- Resilience4j integration for Spring Boot 3 -->
<dependency>
    <groupId>io.github.resilience4j</groupId>
    <artifactId>resilience4j-spring-boot3</artifactId>
    <version>2.2.0</version>
</dependency>
<!-- Required: Resilience4j annotations are implemented as Spring AOP aspects -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-aop</artifactId>
</dependency>
<!-- Already present from 6.x/7.x; needed for health + metrics endpoints -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>

<!-- Test: WireMock to simulate a flaky provider -->
<dependency>
    <groupId>org.wiremock</groupId>
    <artifactId>wiremock-standalone</artifactId>
    <version>3.9.2</version>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.awaitility</groupId>
    <artifactId>awaitility</artifactId>
    <scope>test</scope>
</dependency>
~~~

Note the artifact is ^resilience4j-spring-boot3^ (the ^-spring-boot2^ artifact targets the old javax world). Awaitility's version is managed by the Spring Boot BOM.

### Step 2: Typed configuration for the notification service

~~~java src/main/java/com/example/taskflow/notification/NotificationProperties.java
package com.example.taskflow.notification;

import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.net.URI;
import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "taskflow.notification")
public record NotificationProperties(
        @NotNull URI baseUrl,
        @NotNull String apiKey,
        @NotNull Duration connectTimeout,
        @NotNull Duration readTimeout
) { }
~~~

Register it in the main class with ^@ConfigurationPropertiesScan^ (added in 7.1; if missing, add it to ^TaskflowApplication^).

### Step 3: A RestClient with explicit timeouts

~~~java src/main/java/com/example/taskflow/notification/NotificationClientConfig.java
package com.example.taskflow.notification;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.http.HttpClient;
import java.util.concurrent.Executors;

@Configuration
public class NotificationClientConfig {

    @Bean
    RestClient notificationRestClient(RestClient.Builder builder, NotificationProperties props) {
        // The JDK HttpClient owns the connect timeout and connection pooling.
        HttpClient httpClient = HttpClient.newBuilder()
                .connectTimeout(props.connectTimeout())
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .executor(Executors.newVirtualThreadPerTaskExecutor())
                .build();

        // The factory applies the read (response) timeout to every request.
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(httpClient);
        factory.setReadTimeout(props.readTimeout());

        return builder
                .baseUrl(props.baseUrl().toString())
                .requestFactory(factory)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + props.apiKey())
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .build();
    }
}
~~~

Why inject ^RestClient.Builder^ instead of ^RestClient.create()^? The Boot-provided builder is pre-configured with your Jackson ^ObjectMapper^ and, importantly for lesson 8.6, with the ^ObservationRegistry^ so every outbound call is automatically timed and traced.

### Step 4: DTOs and the client

~~~java src/main/java/com/example/taskflow/notification/NotificationRequest.java
package com.example.taskflow.notification;

public record NotificationRequest(String to, String subject, String body) { }
~~~

~~~java src/main/java/com/example/taskflow/notification/NotificationResult.java
package com.example.taskflow.notification;

public record NotificationResult(Status status, String providerMessageId) {

    public enum Status { SENT, QUEUED }

    public static NotificationResult sent(String id) { return new NotificationResult(Status.SENT, id); }

    public static NotificationResult queued() { return new NotificationResult(Status.QUEUED, null); }
}
~~~

Now the protected client. Note the exception mapping: a 4xx is our bug, so it becomes a non-retryable ^NotificationRejectedException^; 5xx and 429 become ^NotificationUnavailableException^, which is retryable and recorded by the breaker.

~~~java src/main/java/com/example/taskflow/notification/NotificationRejectedException.java
package com.example.taskflow.notification;

/** 4xx from the provider: retrying will not help. */
public class NotificationRejectedException extends RuntimeException {
    public NotificationRejectedException(String message) { super(message); }
}
~~~

~~~java src/main/java/com/example/taskflow/notification/NotificationUnavailableException.java
package com.example.taskflow.notification;

/** 5xx or 429 from the provider: transient, worth retrying later. */
public class NotificationUnavailableException extends RuntimeException {
    public NotificationUnavailableException(String message) { super(message); }
}
~~~

~~~java src/main/java/com/example/taskflow/notification/NotificationClient.java
package com.example.taskflow.notification;

import io.github.resilience4j.bulkhead.annotation.Bulkhead;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.util.Map;
import java.util.UUID;

@Component
public class NotificationClient {

    private static final Logger log = LoggerFactory.getLogger(NotificationClient.class);
    static final String NAME = "notification";

    private final RestClient restClient;

    public NotificationClient(RestClient notificationRestClient) {
        this.restClient = notificationRestClient;
    }

    /**
     * Sends an email. Order applied by Resilience4j (outer to inner):
     * Retry -> CircuitBreaker -> RateLimiter -> Bulkhead -> HTTP call.
     * The idempotency key is the SAME for every retry attempt of one logical send.
     */
    @Retry(name = NAME)
    @CircuitBreaker(name = NAME)
    @RateLimiter(name = NAME)
    @Bulkhead(name = NAME)
    public NotificationResult send(NotificationRequest request, UUID idempotencyKey) {
        @SuppressWarnings("unchecked")
        Map<String, Object> body = restClient.post()
                .uri("/v1/emails")
                .contentType(MediaType.APPLICATION_JSON)
                .header("Idempotency-Key", idempotencyKey.toString())
                .body(request)
                .retrieve()
                .onStatus(status -> status.value() == HttpStatus.TOO_MANY_REQUESTS.value() || status.is5xxServerError(),
                        (req, res) -> {
                            throw new NotificationUnavailableException("Provider returned " + res.getStatusCode());
                        })
                .onStatus(status -> status.is4xxClientError(),
                        (req, res) -> {
                            throw new NotificationRejectedException("Provider rejected request: " + res.getStatusCode());
                        })
                .body(Map.class);

        String id = body == null ? null : String.valueOf(body.get("id"));
        log.info("Notification sent to={} providerId={} key={}", request.to(), id, idempotencyKey);
        return NotificationResult.sent(id);
    }
}
~~~

Notice there is **no** ^fallbackMethod^ here. We deliberately let exceptions escape the client and handle degradation in the service, which has the context to decide (write to the outbox). Fallbacks inside a low-level client tend to hide failures from callers. Both styles are valid; we will also show the annotation fallback in the exercises.

### Step 5: The outbox for graceful degradation

~~~sql src/main/resources/db/migration/V7__notification_outbox.sql
CREATE TABLE notification_outbox (
    id               UUID PRIMARY KEY,
    recipient        VARCHAR(320) NOT NULL,
    subject          VARCHAR(200) NOT NULL,
    body             TEXT         NOT NULL,
    attempts         INT          NOT NULL DEFAULT 0,
    last_error       VARCHAR(500),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    sent_at          TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending ON notification_outbox (created_at) WHERE sent_at IS NULL;
~~~

The outbox row id doubles as the **idempotency key**: every redelivery attempt for that row sends the same key, so the provider never sends the email twice.

~~~java src/main/java/com/example/taskflow/notification/OutboxNotification.java
package com.example.taskflow.notification;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "notification_outbox")
public class OutboxNotification {

    @Id
    private UUID id;
    @Column(nullable = false)
    private String recipient;
    @Column(nullable = false)
    private String subject;
    @Column(nullable = false, columnDefinition = "text")
    private String body;
    private int attempts;
    private String lastError;
    private Instant createdAt;
    private Instant sentAt;

    protected OutboxNotification() { }

    public OutboxNotification(UUID id, NotificationRequest request) {
        this.id = id;
        this.recipient = request.to();
        this.subject = request.subject();
        this.body = request.body();
        this.createdAt = Instant.now();
    }

    public NotificationRequest toRequest() { return new NotificationRequest(recipient, subject, body); }

    public void markSent() { this.sentAt = Instant.now(); }

    public void markFailed(String error) {
        this.attempts++;
        this.lastError = error == null ? null : error.substring(0, Math.min(error.length(), 500));
    }

    public UUID getId() { return id; }
    public int getAttempts() { return attempts; }
    public Instant getSentAt() { return sentAt; }
}
~~~

~~~java src/main/java/com/example/taskflow/notification/OutboxNotificationRepository.java
package com.example.taskflow.notification;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface OutboxNotificationRepository extends JpaRepository<OutboxNotification, UUID> {

    List<OutboxNotification> findBySentAtIsNullAndAttemptsLessThanOrderByCreatedAtAsc(int maxAttempts, Limit limit);
}
~~~

### Step 6: The service that decides how to degrade

~~~java src/main/java/com/example/taskflow/notification/NotificationService.java
package com.example.taskflow.notification;

import io.github.resilience4j.bulkhead.BulkheadFullException;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.ratelimiter.RequestNotPermitted;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.ResourceAccessException;

import java.util.UUID;

@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);
    private static final int MAX_ATTEMPTS = 10;

    private final NotificationClient client;
    private final OutboxNotificationRepository outbox;

    public NotificationService(NotificationClient client, OutboxNotificationRepository outbox) {
        this.client = client;
        this.outbox = outbox;
    }

    /** Never throws for transient problems: the email is sent now or queued for later. */
    @Transactional
    public NotificationResult notifyAssignee(String email, String taskTitle, String projectName) {
        NotificationRequest request = new NotificationRequest(
                email,
                "You were assigned: " + taskTitle,
                "A task in project " + projectName + " is now yours: " + taskTitle);
        OutboxNotification entry = outbox.save(new OutboxNotification(UUID.randomUUID(), request));
        return attempt(entry);
    }

    /** Redelivers queued notifications every 30 s. The circuit breaker keeps this cheap while the provider is down. */
    @Scheduled(fixedDelayString = "PT30S", initialDelayString = "PT30S")
    @Transactional
    public void redeliverPending() {
        var pending = outbox.findBySentAtIsNullAndAttemptsLessThanOrderByCreatedAtAsc(MAX_ATTEMPTS, Limit.of(50));
        pending.forEach(this::attempt);
    }

    private NotificationResult attempt(OutboxNotification entry) {
        try {
            NotificationResult result = client.send(entry.toRequest(), entry.getId());
            entry.markSent();
            return result;
        } catch (CallNotPermittedException | BulkheadFullException | RequestNotPermitted e) {
            // Rejected locally, the provider was not even called: cheap, expected while degraded.
            log.debug("Notification {} deferred: {}", entry.getId(), e.getMessage());
            return NotificationResult.queued();
        } catch (NotificationUnavailableException | ResourceAccessException e) {
            entry.markFailed(e.getMessage());
            log.warn("Notification {} failed after retries, queued: {}", entry.getId(), e.getMessage());
            return NotificationResult.queued();
        } catch (NotificationRejectedException e) {
            // Permanent error: stop retrying, keep the row for investigation.
            for (int i = entry.getAttempts(); i < MAX_ATTEMPTS; i++) entry.markFailed(e.getMessage());
            log.error("Notification {} permanently rejected: {}", entry.getId(), e.getMessage());
            return NotificationResult.queued();
        }
    }
}
~~~

Enable scheduling once with ^@EnableScheduling^ on a configuration class (or the main class). In a multi-instance deployment you would add a lock (for example ShedLock or ^SELECT ... FOR UPDATE SKIP LOCKED^) so two pods do not redeliver the same row - a good exercise topic.

A subtle point: we hold a database transaction open during the HTTP call. With a 2 s read timeout and a bulkhead of 10 that is acceptable for TaskFlow, but at scale you would commit the outbox row first and send after commit (^@TransactionalEventListener(phase = AFTER_COMMIT)^) so remote latency never holds DB connections.

### Step 7: Wire it into TaskService

Only the changed method is new; the rest of ^TaskService^ from 7.2 stays the same.

~~~java src/main/java/com/example/taskflow/service/TaskService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.User;
import com.example.taskflow.notification.NotificationResult;
import com.example.taskflow.notification.NotificationService;
import com.example.taskflow.repository.TaskRepository;
import com.example.taskflow.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class TaskService {

    private final TaskRepository taskRepository;
    private final UserRepository userRepository;
    private final NotificationService notificationService;

    public TaskService(TaskRepository taskRepository, UserRepository userRepository,
                       NotificationService notificationService) {
        this.taskRepository = taskRepository;
        this.userRepository = userRepository;
        this.notificationService = notificationService;
    }

    // ... create, findById, list, update, delete from lesson 7.2 unchanged ...

    @Transactional
    public TaskResponse assign(Long taskId, Long userId) {
        Task task = taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
        User assignee = userRepository.findById(userId)
                .orElseThrow(() -> new ResourceNotFoundException("User", userId));
        task.setAssignee(assignee);

        NotificationResult result = notificationService.notifyAssignee(
                assignee.getEmail(), task.getTitle(), task.getProject().getName());

        return TaskResponse.from(task, result.status() == NotificationResult.Status.QUEUED);
    }
}
~~~

^TaskResponse.from(task, notificationQueued)^ is a small addition to the existing record: a ^boolean notificationQueued^ component so the client can display "the assignee will be notified shortly". The core operation - assigning the task - succeeds regardless of the email provider.

### Step 8: Resilience configuration in application.yml

~~~yaml src/main/resources/application.yml (additions)
taskflow:
  notification:
    base-url: §{NOTIFICATION_BASE_URL:http://localhost:8089}
    api-key: §{NOTIFICATION_API_KEY:dev-key}
    connect-timeout: 1s
    read-timeout: 2s

resilience4j:
  circuitbreaker:
    configs:
      default:
        register-health-indicator: true
        sliding-window-type: COUNT_BASED
        sliding-window-size: 10
        minimum-number-of-calls: 5
        failure-rate-threshold: 50
        slow-call-duration-threshold: 2s
        slow-call-rate-threshold: 80
        wait-duration-in-open-state: 10s
        permitted-number-of-calls-in-half-open-state: 3
        automatic-transition-from-open-to-half-open-enabled: true
        record-exceptions:
          - com.example.taskflow.notification.NotificationUnavailableException
          - org.springframework.web.client.ResourceAccessException
        ignore-exceptions:
          - com.example.taskflow.notification.NotificationRejectedException
    instances:
      notification:
        base-config: default
  retry:
    instances:
      notification:
        max-attempts: 3
        wait-duration: 200ms
        enable-exponential-backoff: true
        exponential-backoff-multiplier: 2
        enable-randomized-wait: true
        randomized-wait-factor: 0.5
        retry-exceptions:
          - com.example.taskflow.notification.NotificationUnavailableException
          - org.springframework.web.client.ResourceAccessException
        ignore-exceptions:
          - com.example.taskflow.notification.NotificationRejectedException
          - io.github.resilience4j.circuitbreaker.CallNotPermittedException
  bulkhead:
    instances:
      notification:
        max-concurrent-calls: 10
        max-wait-duration: 50ms
  ratelimiter:
    instances:
      notification:
        limit-for-period: 20
        limit-refresh-period: 1s
        timeout-duration: 100ms

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus,circuitbreakers,circuitbreakerevents,retries,retryevents,ratelimiters,bulkheads
  endpoint:
    health:
      show-details: when-authorized
  health:
    circuitbreakers:
      enabled: true
~~~

Read the retry block carefully: 3 attempts total (1 + 2 retries), waits around 200 ms then 400 ms, each randomized by plus or minus 50% (that is the jitter). Worst-case latency for a fully failing call is roughly 3 x 2 s read timeout + 0.6 s waits = 6.6 s. If that is too long for an HTTP request, lower the read timeout or attempts - **always compute the worst case** for your config. Note that with Resilience4j 2.x, exponential backoff combined with randomization is supported via these two flags together.

Also note the **health indicator decision**. With ^register-health-indicator: true^ an OPEN breaker makes ^/actuator/health^ report the circuit breaker component as ^CIRCUIT_OPEN^. Do **not** let that flip the liveness or readiness probe to DOWN: Kubernetes would restart or remove healthy TaskFlow pods because a non-critical email provider is down - a self-inflicted cascade. Keep circuit breaker health out of the probe groups (Boot's ^liveness^ and ^readiness^ groups by default only include their own state indicators, which is correct).

### Step 9: A flaky provider in Docker Compose

~~~yaml docker-compose.yml (new service + app env)
services:
  notification-stub:
    image: wiremock/wiremock:3.9.2
    ports:
      - "8089:8080"
    volumes:
      - ./wiremock:/home/wiremock
    command: ["--global-response-templating", "--verbose"]

  app:
    # ... existing build, ports, depends_on postgres from 7.3 ...
    environment:
      NOTIFICATION_BASE_URL: http://notification-stub:8080
      NOTIFICATION_API_KEY: dev-key
~~~

~~~json wiremock/mappings/emails-flaky.json
{
  "mappings": [
    {
      "priority": 1,
      "request": { "method": "POST", "urlPath": "/v1/emails" },
      "response": {
        "status": 200,
        "headers": { "Content-Type": "application/json" },
        "jsonBody": { "id": "msg-123", "status": "accepted" },
        "delayDistribution": { "type": "lognormal", "median": 150, "sigma": 0.6 }
      }
    }
  ]
}
~~~

To simulate an outage at runtime, use WireMock's admin API to add a higher-priority 503 stub or a 5-second fixed delay:

~~~powershell
# Make the provider fail
Invoke-RestMethod -Method Post -Uri http://localhost:8089/__admin/mappings -ContentType "application/json" -Body '{"priority":0,"request":{"method":"POST","urlPath":"/v1/emails"},"response":{"status":503}}'

# Assign tasks a few times (use your JWT from lesson 7.2)
$token = "eyJhbGciOi..."
1..8 | ForEach-Object { Invoke-RestMethod -Method Put -Uri http://localhost:8080/api/tasks/1/assignee/2 -Headers @{Authorization = "Bearer $token"} }

# Inspect the breaker
Invoke-RestMethod http://localhost:8080/actuator/circuitbreakers
Invoke-RestMethod http://localhost:8080/actuator/circuitbreakerevents/notification

# Heal the provider
Invoke-RestMethod -Method Post -Uri http://localhost:8089/__admin/mappings/reset
~~~

Expected output from ^/actuator/circuitbreakers^ after the failures:

~~~json
{
  "circuitBreakers": {
    "notification": {
      "failureRate": "100.0%",
      "slowCallRate": "0.0%",
      "failureRateThreshold": "50.0%",
      "bufferedCalls": 5,
      "failedCalls": 5,
      "notPermittedCalls": 9,
      "state": "OPEN"
    }
  }
}
~~~

Each assignment still returns 200 with ^"notificationQueued": true^. After 10 seconds the breaker goes HALF_OPEN; once you reset WireMock, the next 3 calls (from users or the 30 s redelivery job) succeed and it CLOSES, and the outbox drains.

### Step 10: Metrics you get for free

With Actuator and Micrometer on the classpath, Resilience4j publishes metrics such as:

| Metric | Tags | Use |
|---|---|---|
| resilience4j_circuitbreaker_state | name, state | Alert when state="open" equals 1 |
| resilience4j_circuitbreaker_calls_seconds | name, kind (successful, failed, ignored, not_permitted) | Failure rate and latency |
| resilience4j_circuitbreaker_failure_rate | name | Graph trend toward threshold |
| resilience4j_retry_calls_total | name, kind (successful_without_retry, successful_with_retry, failed_with_retry, failed_without_retry) | Detect hidden flakiness |
| resilience4j_bulkhead_available_concurrent_calls | name | Saturation |
| resilience4j_ratelimiter_available_permissions | name | Quota headroom |

A rising ^successful_with_retry^ count is an early warning: users are fine, but the dependency is degrading and retries are masking it. Lesson 8.6 turns these into Grafana panels and alerts.

### Step 11: Testing the retry policy with WireMock

~~~java src/test/java/com/example/taskflow/notification/NotificationRetryTest.java
package com.example.taskflow.notification;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
class NotificationRetryTest {

    static final WireMockServer wm = new WireMockServer(wireMockConfig().dynamicPort());

    static { wm.start(); }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("taskflow.notification.base-url", wm::baseUrl);
    }

    @Autowired NotificationClient client;
    @Autowired io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry breakers;

    @BeforeEach
    void reset() {
        wm.resetAll();
        breakers.circuitBreaker("notification").reset();
    }

    @AfterAll
    static void stop() { wm.stop(); }

    @Test
    void retriesTransientFailureWithSameIdempotencyKey() {
        wm.stubFor(post("/v1/emails").inScenario("flaky").whenScenarioStateIs(Scenario.STARTED)
                .willReturn(aResponse().withStatus(503)).willSetStateTo("recovered"));
        wm.stubFor(post("/v1/emails").inScenario("flaky").whenScenarioStateIs("recovered")
                .willReturn(okJson("{\"id\":\"msg-1\"}")));

        UUID key = UUID.randomUUID();
        NotificationResult result = client.send(new NotificationRequest("a@x.io", "s", "b"), key);

        assertThat(result.status()).isEqualTo(NotificationResult.Status.SENT);
        wm.verify(2, postRequestedFor(urlEqualTo("/v1/emails"))
                .withHeader("Idempotency-Key", equalTo(key.toString())));
    }

    @Test
    void doesNotRetryClientErrors() {
        wm.stubFor(post("/v1/emails").willReturn(aResponse().withStatus(422)));

        assertThatThrownBy(() -> client.send(new NotificationRequest("bad", "s", "b"), UUID.randomUUID()))
                .isInstanceOf(NotificationRejectedException.class);
        wm.verify(1, postRequestedFor(urlEqualTo("/v1/emails")));
    }
}
~~~

This test needs PostgreSQL for the context; reuse the Testcontainers ^@ServiceConnection^ setup from lesson 7.3 (an abstract ^IntegrationTestBase^) - extend it instead of repeating config.

### Step 12: Testing circuit breaker transitions

~~~java src/test/java/com/example/taskflow/notification/NotificationCircuitBreakerIT.java
package com.example.taskflow.notification;

import com.github.tomakehurst.wiremock.WireMockServer;
import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerRegistry;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.time.Duration;
import java.util.UUID;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

@SpringBootTest(properties = {
        "resilience4j.circuitbreaker.instances.notification.wait-duration-in-open-state=500ms",
        "resilience4j.retry.instances.notification.max-attempts=1"
})
class NotificationCircuitBreakerIT {

    static final WireMockServer wm = new WireMockServer(wireMockConfig().dynamicPort());

    static { wm.start(); }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("taskflow.notification.base-url", wm::baseUrl);
    }

    @Autowired NotificationClient client;
    @Autowired CircuitBreakerRegistry registry;
    CircuitBreaker breaker;

    @BeforeEach
    void setUp() {
        wm.resetAll();
        breaker = registry.circuitBreaker("notification");
        breaker.reset();
    }

    @AfterAll
    static void stop() { wm.stop(); }

    private void call() {
        client.send(new NotificationRequest("a@x.io", "s", "b"), UUID.randomUUID());
    }

    @Test
    void closedToOpenToHalfOpenToClosed() {
        wm.stubFor(post("/v1/emails").willReturn(aResponse().withStatus(503)));

        for (int i = 0; i < 5; i++) {
            assertThatThrownBy(this::call).isInstanceOf(NotificationUnavailableException.class);
        }
        assertThat(breaker.getState()).isEqualTo(CircuitBreaker.State.OPEN);

        // OPEN: rejected locally, provider not called
        int before = wm.getAllServeEvents().size();
        assertThatThrownBy(this::call).isInstanceOf(CallNotPermittedException.class);
        assertThat(wm.getAllServeEvents()).hasSize(before);

        // after waitDurationInOpenState the timer moves it to HALF_OPEN
        await().atMost(Duration.ofSeconds(3))
                .until(() -> breaker.getState() == CircuitBreaker.State.HALF_OPEN);

        // provider heals: 3 permitted trial calls succeed -> CLOSED
        wm.resetAll();
        wm.stubFor(post("/v1/emails").willReturn(okJson("{\"id\":\"ok\"}")));
        for (int i = 0; i < 3; i++) call();

        assertThat(breaker.getState()).isEqualTo(CircuitBreaker.State.CLOSED);
    }

    @Test
    void slowCallsAreTimedOutAndCounted() {
        wm.stubFor(post("/v1/emails").willReturn(okJson("{\"id\":\"slow\"}").withFixedDelay(3000)));

        assertThatThrownBy(this::call).isInstanceOf(org.springframework.web.client.ResourceAccessException.class);
        assertThat(breaker.getMetrics().getNumberOfFailedCalls()).isEqualTo(1);
    }
}
~~~

The second test proves the read timeout works: the provider takes 3 s, our client gives up at 2 s with a ^ResourceAccessException^ (wrapping ^HttpTimeoutException^), and the breaker records it as a failure. Overriding properties per test keeps runs fast; never sleep for the production 10 s.

Run everything:

~~~powershell
./mvnw test -Dtest="Notification*"
~~~

---

## 3. Common Pitfalls & Best Practices

- **No timeouts on HTTP clients.** Defaults are often infinite or very long. Fix: set connect and read timeouts on every client, derived from the dependency's p99 and your own latency budget.
- **Retrying non-idempotent operations blindly.** A timeout after the provider acted plus a retry equals a duplicate email or double charge. Fix: send a stable idempotency key per logical operation and reuse it on every attempt and redelivery.
- **Retrying everything at every layer.** Retries multiply across layers and become retry storms. Fix: retry at one layer, use backoff with jitter, cap attempts, and never retry 4xx or ^CallNotPermittedException^.
- **Calling an annotated method from the same class.** Self-invocation bypasses the Spring AOP proxy, so no breaker or retry runs. Fix: put resilient calls in a separate bean (like ^NotificationClient^) and forget ^spring-boot-starter-aop^ at your peril - without it the annotations do nothing, silently.
- **Counting client errors as failures.** If 404 or 422 open the breaker, one bad input pattern disables a healthy dependency for everyone. Fix: configure ^ignore-exceptions^ for client-error exceptions and ^record-exceptions^ for real outages.
- **Wiring circuit breaker health into readiness/liveness probes.** An OPEN breaker on a non-critical dependency gets your healthy pods killed. Fix: keep breakers in general health for visibility, out of probe groups.
- **Fallbacks that hide data loss.** Returning "OK" while dropping the email means nobody notices. Fix: degrade to a durable outbox, expose a flag to the client, and alert on outbox backlog and breaker state.
- **Never computing the worst case.** Attempts x read timeout + backoff can exceed your own SLA or a gateway timeout. Fix: calculate it, write it in a comment next to the config, and test it.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Make TaskFlow survive an email outage","tasks":["Add the dependencies, NotificationClient, NotificationService, the V7 outbox migration and the resilience4j block exactly as in the walkthrough, then start the stack with docker compose up including the WireMock notification-stub.","Use the WireMock admin API to return 503, assign a task 8 times, and record the JSON from ^/actuator/circuitbreakers^ and ^/actuator/circuitbreakerevents/notification^. Identify the event where the state changed to OPEN.","Reset WireMock, wait for the redelivery job, and verify in PostgreSQL that every outbox row now has a non-null ^sent_at^ and that WireMock received each idempotency key only for the expected number of attempts.","Replace the 503 stub with a fixed 5 second delay and confirm in the logs that each attempt is cut off at about 2 seconds. Write down the measured worst-case latency of one assignment request and compare it to your calculated value."]},
{"title":"Exercise 2 (Challenge): Annotation fallback, time limiter and multi-instance safety","tasks":["Create a second client method ^fetchDeliveryStatus(String providerMessageId)^ that is idempotent (GET), protected by ^@CircuitBreaker(name = \"notificationStatus\", fallbackMethod = \"statusUnknown\")^ with its own instance config. Write the fallback with the correct signature and a test proving it runs for both ^CallNotPermittedException^ and ^NotificationUnavailableException^.","Make an async variant returning ^CompletableFuture^ and protect it with ^@TimeLimiter^ plus ^@CircuitBreaker^. Read the Resilience4j docs on TimeLimiter and explain in a comment why the time limiter is not a replacement for HTTP read timeouts.","Change ^redeliverPending^ so two TaskFlow instances never send the same outbox row concurrently, using a native query with ^FOR UPDATE SKIP LOCKED^. Prove it with a test that runs the method from two threads.","Respect the provider's ^Retry-After^ header on HTTP 429 by reading it in the error handler and using Resilience4j's ^IntervalBiFunction^ via a custom ^RetryConfigCustomizer^ bean."]},
{"title":"Exercise 3 (Thinking): Designing resilience budgets","tasks":["TaskFlow's assign endpoint has a 3 second SLO at p99 and sits behind an API gateway with a 5 second timeout. Choose connect timeout, read timeout, attempts and backoff for the notification client and justify each number in a short table.","Describe step by step what happens to TaskFlow's Tomcat thread pool (or virtual threads plus DB connection pool) during a 10 minute provider slowdown with and without the bulkhead and circuit breaker. Which resource runs out first in each case?","You upgrade TaskFlow to Spring Boot 4. List which parts of this lesson you could replace with Spring Framework 7's ^@Retryable^ and ^@ConcurrencyLimit^, which parts you would keep on Resilience4j, and why.","Explain the difference between graceful degradation and load shedding using one concrete TaskFlow endpoint for each, and describe which metric would tell you each mechanism is active."]}
]
};
