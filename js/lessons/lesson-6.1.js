LESSONS['6.1']={
md:String.raw`## 1. Concept & Theory

Welcome to Module 6, Julian. Up to now the Bookstore API has been built (2.x), persisted with JPA and PostgreSQL (3.x), secured with users and roles (4.x) and tested (5.x). It works on your laptop. But "works on my laptop" is not the same as "runs in production". In production nobody is attached with a debugger. When something breaks at 3 a.m., the only things you have are **logs**, **metrics** and **health checks**, and the app has to behave differently in each **environment** (dev, test, prod) without being recompiled. This lesson makes the Bookstore API *operable*.

**Where the project stands.** We have the packages ^controller^, ^service^, ^repository^, ^model^, ^dto^, ^exception^, ^config^ and ^security^, a ^SecurityConfig^ with a ^SecurityFilterChain^, a ^GlobalExceptionHandler^ returning ^ProblemDetail^, and PostgreSQL configured in ^application.yml^. Actuator was already added as a dependency in 2.1, but we never configured it.

**New / changed files in this lesson:**

| File | Status |
|---|---|
| src/main/resources/application.yml | changed (logging, actuator, shutdown, profile groups) |
| src/main/resources/application-dev.yml | new |
| src/main/resources/application-test.yml | new |
| src/main/resources/application-prod.yml | new |
| config/RequestIdFilter.java | new |
| config/BookCatalogHealthIndicator.java | new |
| config/DevDataConfig.java | new |
| service/BookService.java | changed (logging) |
| exception/GlobalExceptionHandler.java | changed (logging) |
| security/SecurityConfig.java | changed (actuator rules) |

### 1.1 The real-world analogy: an airplane

Think of the app as an airplane. **Logs** are the black box flight recorder: a detailed, time-ordered story of what happened, read after an incident. **Metrics** are the cockpit gauges: numbers (altitude, fuel, speed) you watch continuously and alert on. **Health checks** are the pre-flight checklist and the "is the engine running?" light that ground control (Docker, Kubernetes, a load balancer) looks at. **Profiles** are the flight plan: the same plane flies different routes with different settings. You would never fly a plane with no recorder, no gauges and a hard-coded route. Yet many first apps ship exactly like that.

### 1.2 Logging: SLF4J is the facade, Logback is the engine

Java has many logging libraries (java.util.logging, Log4j2, Logback, JBoss Logging...). Libraries you depend on (Hibernate, Tomcat, Spring itself) each use one. If every library wrote in its own way, you would configure five logging systems. The solution is a **facade**.

| Piece | Role | Analogy |
|---|---|---|
| SLF4J (^org.slf4j.Logger^) | The API your code calls. Only interfaces. | The wall socket |
| Logback | The implementation that formats and writes logs. Default in Spring Boot. | The power plant |
| Bridges (jul-to-slf4j, log4j-to-slf4j) | Redirect other logging APIs into SLF4J | Plug adapters |
| Spring Boot ^LoggingSystem^ | Configures Logback from ^application.yml^ at startup | The electrician |

**Under the hood:** ^spring-boot-starter-web^ pulls in ^spring-boot-starter-logging^, which brings Logback plus the bridges. Very early in startup (before the ApplicationContext even exists) Spring Boot's ^LoggingApplicationListener^ reacts to the ^ApplicationEnvironmentPreparedEvent^, picks the ^LogbackLoggingSystem^, and applies the ^logging.*^ properties from your environment. That is why you can set log levels in YAML without ever writing a ^logback.xml^. Your code only ever imports ^org.slf4j^, so you could swap Logback for Log4j2 by changing dependencies only.

### 1.3 Log levels and when to use each

| Level | Use it for | Bookstore example | On in prod? |
|---|---|---|---|
| ERROR | Something failed and needs human attention | Unexpected exception in the handler, DB down | Yes |
| WARN | Unusual but handled; may become a problem | Book not found for an id, retry happened | Yes |
| INFO | Important business or lifecycle events | Book created with id 42, app started | Yes |
| DEBUG | Developer detail for diagnosing | Query parameters, cache hits | Usually no |
| TRACE | Extremely detailed flow | Every SQL bind value | No |

A good rule: **INFO tells the story of the business, DEBUG tells the story of the code.** If your INFO log fires 1,000 times per second, it is not INFO, it is noise, and you will pay for it in log storage. Note: a 404 for a missing book is a *client* error, so it is often logged at DEBUG or WARN, not ERROR. Reserve ERROR for things that mean your system is broken; teams usually alert on ERROR, and false alarms train people to ignore alerts.

### 1.4 Parameterized logging

~~~java
log.info("Created book " + book.getTitle() + " with id " + book.getId()); // bad
log.info("Created book '{}' with id {}", book.getTitle(), book.getId());   // good
~~~

Why the second one? With string concatenation, Java builds the string **even when the level is disabled**. With ^{}^ placeholders, SLF4J first checks whether the level is enabled and only formats the message if needed. It is also cleaner, and structured logging tools can keep the template separate from values. If you pass an exception as the **last argument**, SLF4J prints the full stack trace: ^log.error("Failed to save book {}", id, ex)^.

### 1.5 Never log secrets or PII

Logs are copied to many places (files, log aggregators, backups, support tickets) and are often readable by many more people than your database. Never log passwords, JWTs, API keys, the ^Authorization^ header, full credit card numbers, or personal data (PII: emails, addresses, phone numbers) unless legally cleared and masked. Under GDPR, a log file full of emails is personal data you must protect and delete on request. Practical rules: log **ids**, not entities (never call ^log.info("{}", user)^ on an entity whose ^toString()^ includes a password hash), and be careful with records: a record's generated ^toString()^ prints **every** field.

### 1.6 Logging configuration in YAML, and logging groups

~~~yaml
logging:
  level:
    root: INFO
    com.example.bookstore: DEBUG
    org.hibernate.SQL: DEBUG
  group:
    bookstore-web: com.example.bookstore.controller, com.example.bookstore.config
~~~

^logging.level.<logger-name>^ sets the level for a package and everything under it (loggers are hierarchical by package name). **Logging groups** let you name a set of loggers and change them together: ^logging.level.bookstore-web: TRACE^. Spring Boot ships two predefined groups: ^web^ (Spring MVC, codecs, HTTP) and ^sql^ (Spring JDBC, Hibernate SQL). So ^logging.level.sql: DEBUG^ shows the SQL Hibernate runs, which is how you spot the N+1 problem from lesson 3.3.

### 1.7 Structured JSON logging (Spring Boot 3.4+)

Human-readable lines are great on your laptop. In production, logs go to a system like Elasticsearch/Kibana, Grafana Loki, Datadog or CloudWatch. Those systems want **JSON**, one object per line, so they can filter by field (^level = ERROR AND requestId = abc^) instead of grep-ing text. Before 3.4 you needed an extra library (logstash-logback-encoder). Since Spring Boot 3.4 it is built in:

~~~yaml
logging:
  structured:
    format:
      console: ecs        # or: logstash, gelf
~~~

| Format | Who uses it |
|---|---|
| ecs | Elastic Common Schema (Elasticsearch, Kibana, many others) |
| logstash | Logstash JSON format |
| gelf | Graylog Extended Log Format (3.4+) |

MDC values (next section) automatically become JSON fields. A typical line looks like: ^{"@timestamp":"...","log.level":"INFO","message":"Created book","requestId":"7f3c...","service.name":"bookstore"}^. We will enable JSON only in the prod profile, and keep pretty text in dev.

### 1.8 MDC and the request id (correlation id)

In production, 200 requests may be served concurrently, and their log lines interleave. How do you find the 6 lines that belong to *one* failing request? You tag each line with a **request id**. **MDC** (Mapped Diagnostic Context) is a per-thread map maintained by SLF4J/Logback: whatever you put in it is added to every log line written by that thread. A servlet filter generates (or accepts from the caller) an ^X-Request-Id^ header, puts it into MDC, echoes it in the response, and **removes it in a finally block**. That last part matters: Tomcat reuses threads from a pool, so a forgotten MDC value would leak into the next unrelated request.

When the same id is passed between services (gateway to bookstore to payment service), it becomes a **correlation id** and lets you follow a request across a whole system. (Micrometer Tracing does this automatically with ^traceId^/^spanId^; our filter is the simple, dependency-free version and teaches you what tracing does under the hood.) Caveat: MDC is thread-local, so ^@Async^ methods or ^CompletableFuture^ tasks will not see it unless you propagate it.

### 1.9 @Slf4j vs explicit LoggerFactory

Lombok's ^@Slf4j^ generates ^private static final Logger log = LoggerFactory.getLogger(MyClass.class);^. It saves one line, but adds an annotation processor to your build, IDE plugin requirements and a layer of magic. In this course we write the line explicitly: zero dependencies, works in every IDE, and you can see exactly what happens. If your team already uses Lombok, ^@Slf4j^ is fine; the result is identical.

### 1.10 Profiles: one artifact, many environments

The **twelve-factor app** principle says: build **one** artifact (the same JAR or Docker image) and promote it from test to prod. Only configuration changes. Spring profiles are how you organize that configuration.

| Mechanism | What it does |
|---|---|
| ^application.yml^ | Always loaded; shared defaults |
| ^application-dev.yml^ | Loaded only when profile ^dev^ is active; overrides defaults |
| ^spring.profiles.active^ | Chooses active profiles (property, env var ^SPRING_PROFILES_ACTIVE^, or ^--spring.profiles.active=prod^) |
| ^@Profile("dev")^ | Creates a bean only when that profile is active |
| ^spring.profiles.group^ | One profile name activates several (^prod^ = ^prod^ + ^json-logs^) |
| ^spring.config.import^ | Pulls in extra config files or sources (^optional:file:./secrets.yml^, config server, Vault) |
| ^@ActiveProfiles("test")^ | Activates a profile in tests |

**Under the hood: property precedence.** Spring builds an ^Environment^ containing an ordered list of ^PropertySource^ objects. When you ask for ^spring.datasource.password^, it walks the list and returns the first match. Simplified order, highest wins:

1. Command-line arguments (^--server.port=9090^)
2. Java system properties (^-Dserver.port=9090^)
3. OS environment variables (^SERVER_PORT=9090^)
4. Profile-specific files (^application-prod.yml^), outside the JAR beats inside
5. ^application.yml^, outside the JAR beats inside
6. ^@PropertySource^ and default properties

**Relaxed binding** maps environment variables onto properties: uppercase, dots become underscores, dashes are removed. So ^SPRING_DATASOURCE_URL^ sets ^spring.datasource.url^, and ^MANAGEMENT_SERVER_PORT^ sets ^management.server.port^. This is how Docker and Kubernetes configure Spring apps (lesson 6.2).

### 1.11 Secrets handling

**A secret committed to git is compromised forever**, even if you delete it in the next commit, because history keeps it. Rules: never put real passwords in ^application.yml^; reference them with placeholders and a safe default only for local dev: ^§{DB_PASSWORD:bookstore}^ (in prod, give no default so the app fails fast if it is missing). Supply secrets via environment variables, Docker/Kubernetes secrets, or a secret manager (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault), which Spring can load through ^spring.config.import^. Spring Boot also supports **configtree**: ^spring.config.import: optional:configtree:/run/secrets/^ turns each file in that folder into a property, which is exactly how Docker and Kubernetes mount secrets as files.

### 1.12 Spring Boot Actuator

Actuator adds production-ready **endpoints** under ^/actuator^. Each endpoint is a bean (annotated ^@Endpoint^) that Actuator exposes over HTTP or JMX. By default only ^health^ is exposed over HTTP, for safety: endpoints like ^env^, ^heapdump^ or ^loggers^ can leak secrets or change behavior.

| Endpoint | Purpose | Expose publicly? |
|---|---|---|
| ^/actuator/health^ | UP/DOWN status, plus liveness/readiness groups | Yes (without details) |
| ^/actuator/info^ | Build version, git commit, Java version | Yes |
| ^/actuator/metrics^ | Micrometer metrics browser | No, admins only |
| ^/actuator/prometheus^ | Metrics in Prometheus format (needs micrometer-registry-prometheus) | Internal network only |
| ^/actuator/loggers^ | Read and **change** log levels at runtime | Admins only |
| ^/actuator/env^, ^/actuator/configprops^ | Configuration (values masked by default) | Admins only |
| ^/actuator/heapdump^, ^/actuator/threaddump^ | JVM dumps (heap contains secrets!) | Almost never |
| ^/actuator/shutdown^ | Stops the app (disabled by default) | Never |

**Health: liveness vs readiness.** Orchestrators ask two different questions:

| Probe | Question | If it fails... | URL |
|---|---|---|---|
| Liveness | Is the process broken beyond repair (deadlock, corrupted state)? | Restart the container | ^/actuator/health/liveness^ |
| Readiness | Can it take traffic right now (started, DB reachable, not shutting down)? | Stop sending traffic, do not restart | ^/actuator/health/readiness^ |

A classic production mistake is to include the database in **liveness**. If PostgreSQL is down for 30 seconds, Kubernetes then restarts **every** app instance, which makes the outage worse and causes a restart storm. The database belongs in **readiness** only. Spring Boot tracks this through ^ApplicationAvailability^: readiness becomes ^ACCEPTING_TRAFFIC^ after startup and ^REFUSING_TRAFFIC^ during graceful shutdown. Probes are enabled automatically on Kubernetes; elsewhere set ^management.endpoint.health.probes.enabled: true^.

**Custom HealthIndicator.** Any bean implementing ^HealthIndicator^ is picked up automatically, named after the class minus the "HealthIndicator" suffix, and aggregated into ^/actuator/health^. Spring already auto-configures indicators for the DataSource (^db^), disk space, and more.

**Metrics and Micrometer.** Micrometer is "SLF4J for metrics": a vendor-neutral facade. You record counters, timers and gauges; a registry ships them to Prometheus, Datadog, CloudWatch, etc. Out of the box Boot records JVM memory, GC, threads, HTTP request timings (^http.server.requests^, tagged by URI, method and status), HikariCP connection pool stats and more. Under the hood, an ^ObservationRegistry^ wraps each MVC request in an observation that produces both a timer metric and (if tracing is present) a span.

**Separate management port.** ^management.server.port: 8081^ moves actuator to its own port. The public load balancer only forwards 8080, so actuator is reachable only from inside the cluster. It is a strong defense-in-depth measure, but note Spring Security still applies to it.

### 1.13 Graceful shutdown

When Docker or Kubernetes stops your container, it sends **SIGTERM**, waits a grace period (10s in Docker, 30s in Kubernetes), then SIGKILL. Without graceful shutdown, Tomcat drops in-flight requests: a customer's order is half processed. With ^server.shutdown: graceful^ (the default since Spring Boot 3.4, but we set it explicitly to document intent) Spring: (1) flips readiness to REFUSING_TRAFFIC, (2) stops accepting new connections, (3) waits for active requests up to ^spring.lifecycle.timeout-per-shutdown-phase^, then (4) closes the context, running ^@PreDestroy^ methods and closing the Hikari pool cleanly. Keep that timeout **shorter** than the orchestrator's grace period.

---

## 2. Code Walkthrough

### Step 1: dependencies

Actuator is already in ^pom.xml^ from lesson 2.1. Confirm these are present (versions managed by the Spring Boot parent, 3.4.x):

~~~xml pom.xml (excerpt)
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-actuator</artifactId>
</dependency>
<!-- optional: Prometheus format for /actuator/prometheus -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>
~~~

To fill ^/actuator/info^ with build data, add the ^build-info^ goal to the existing Spring Boot Maven plugin:

~~~xml pom.xml (excerpt, inside build/plugins)
<plugin>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <executions>
        <execution>
            <goals>
                <goal>build-info</goal>
            </goals>
        </execution>
    </executions>
</plugin>
~~~

This generates ^META-INF/build-info.properties^ at build time; Actuator's ^BuildInfoContributor^ reads it.

### Step 2: the shared application.yml

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: bookstore
  profiles:
    # default for a developer who just runs the app
    default: dev
    group:
      prod: prod, json-logs
  config:
    # optional local secrets file, never committed (add to .gitignore)
    import: optional:file:./config/secrets.yml
  jpa:
    open-in-view: false
  lifecycle:
    timeout-per-shutdown-phase: 20s

server:
  port: 8080
  shutdown: graceful

logging:
  level:
    root: INFO
    com.example.bookstore: INFO
  group:
    bookstore-web: com.example.bookstore.controller, com.example.bookstore.config

management:
  endpoints:
    web:
      exposure:
        include: health, info, metrics, prometheus, loggers
  endpoint:
    health:
      show-details: when-authorized
      roles: ADMIN
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState, db, bookCatalog
        liveness:
          include: livenessState
  info:
    env:
      enabled: true
    java:
      enabled: true
    os:
      enabled: true

info:
  app:
    name: Bookstore API
    description: Spring Boot 0 to Hero course project
~~~

Notes: ^spring.profiles.default: dev^ applies only when **no** profile is active, so a developer can just run the app, while prod must be set explicitly. ^show-details: when-authorized^ hides component details from anonymous callers but shows them to ADMIN users. Since Boot 2.6+ the ^info.env^, ^info.java^, ^info.os^ contributors are off by default, so we turn them on. Since we exposed ^loggers^, we must protect it (Step 9).

### Step 3: profile files

~~~yaml src/main/resources/application-dev.yml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/bookstore
    username: bookstore
    password: §{DB_PASSWORD:bookstore}
  jpa:
    hibernate:
      ddl-auto: update

logging:
  level:
    com.example.bookstore: DEBUG
    sql: DEBUG
  pattern:
    # %X{requestId} prints the MDC value
    console: "%d{HH:mm:ss.SSS} %-5level [%X{requestId:-no-req}] %logger{36} - %msg%n"
~~~

~~~yaml src/main/resources/application-test.yml
spring:
  datasource:
    url: jdbc:h2:mem:bookstore;MODE=PostgreSQL;DB_CLOSE_DELAY=-1
    username: sa
    password:
  jpa:
    hibernate:
      ddl-auto: create-drop

logging:
  level:
    root: WARN
    com.example.bookstore: INFO
~~~

~~~yaml src/main/resources/application-prod.yml
spring:
  datasource:
    # no defaults: the app must fail fast if these are missing
    url: §{SPRING_DATASOURCE_URL}
    username: §{SPRING_DATASOURCE_USERNAME}
    password: §{SPRING_DATASOURCE_PASSWORD}
    hikari:
      maximum-pool-size: 10
  jpa:
    hibernate:
      ddl-auto: validate

management:
  server:
    port: 8081
  endpoint:
    health:
      show-details: never

logging:
  level:
    root: INFO
    com.example.bookstore: INFO
~~~

~~~yaml src/main/resources/application-json-logs.yml
logging:
  structured:
    format:
      console: ecs
    ecs:
      service:
        name: bookstore
        environment: prod
~~~

(^application-json-logs.yml^ is also a new file.) Because of the group ^prod: prod, json-logs^, activating ^prod^ also activates ^json-logs^. You can enable JSON logs in a staging environment with ^SPRING_PROFILES_ACTIVE=staging,json-logs^ without duplicating config. That is the power of small, composable profiles. In prod, ^ddl-auto: validate^ means Hibernate checks the schema but never changes it; schema changes belong in migration tools like Flyway.

### Step 4: the request id filter (MDC)

~~~java src/main/java/com/example/bookstore/config/RequestIdFilter.java
package com.example.bookstore.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Puts a request id into the MDC so every log line of this request carries it.
 * Runs before Spring Security so even 401/403 responses are correlated.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Request-Id";
    public static final String MDC_KEY = "requestId";

    // accept only safe ids from callers (prevents log injection)
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9-]{8,64}");

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String requestId = (incoming != null && SAFE_ID.matcher(incoming).matches())
                ? incoming
                : UUID.randomUUID().toString();

        MDC.put(MDC_KEY, requestId);
        response.setHeader(HEADER, requestId);
        try {
            chain.doFilter(request, response);
        } finally {
            // threads are pooled: always clean up
            MDC.remove(MDC_KEY);
        }
    }
}
~~~

Why validate the incoming header? A malicious client could send a header containing newlines and fake log lines (log injection / log forging). Accepting only a safe pattern prevents it. ^OncePerRequestFilter^ guarantees the filter runs once even on internal error dispatches. Spring Boot automatically registers any ^Filter^ bean with the servlet container, and ^HIGHEST_PRECEDENCE^ places it before the Spring Security filter chain.

### Step 5: logging in the service

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.model.Book;
import com.example.bookstore.repository.BookRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class BookService {

    private static final Logger log = LoggerFactory.getLogger(BookService.class);

    private final BookRepository bookRepository;

    public BookService(BookRepository bookRepository) {
        this.bookRepository = bookRepository;
    }

    public Page<BookResponse> findAll(Pageable pageable) {
        log.debug("Listing books page={} size={}", pageable.getPageNumber(), pageable.getPageSize());
        return bookRepository.findAll(pageable).map(BookResponse::from);
    }

    public BookResponse findById(Long id) {
        return bookRepository.findById(id)
                .map(BookResponse::from)
                .orElseThrow(() -> {
                    log.debug("Book {} not found", id);
                    return new BookNotFoundException(id);
                });
    }

    @Transactional
    public BookResponse create(BookRequest request) {
        Book book = new Book();
        book.setTitle(request.title());
        book.setIsbn(request.isbn());
        book.setPrice(request.price());
        book.setPublishedYear(request.publishedYear());
        Book saved = bookRepository.save(book);
        log.info("Created book id={} isbn={}", saved.getId(), saved.getIsbn());
        return BookResponse.from(saved);
    }

    @Transactional
    public BookResponse update(Long id, BookRequest request) {
        Book book = bookRepository.findById(id)
                .orElseThrow(() -> new BookNotFoundException(id));
        book.setTitle(request.title());
        book.setIsbn(request.isbn());
        book.setPrice(request.price());
        book.setPublishedYear(request.publishedYear());
        log.info("Updated book id={}", id);
        return BookResponse.from(book);
    }

    @Transactional
    public void delete(Long id) {
        if (!bookRepository.existsById(id)) {
            throw new BookNotFoundException(id);
        }
        bookRepository.deleteById(id);
        log.info("Deleted book id={}", id);
    }

    public long count() {
        return bookRepository.count();
    }
}
~~~

Note that we log ids and the ISBN (public, non-personal data), never the whole request object. The ^count()^ method is new; the health indicator uses it. (^BookResponse.from(Book)^ is the static factory from lesson 2.2/3.1.)

### Step 6: logging in the exception handler

Only unexpected errors deserve ERROR with a stack trace. Expected business errors get a short line.

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
package com.example.bookstore.exception;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BookNotFoundException.class)
    public ProblemDetail handleNotFound(BookNotFoundException ex) {
        log.warn("Not found: {}", ex.getMessage());
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Book not found");
        return pd;
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ProblemDetail handleValidation(MethodArgumentNotValidException ex) {
        Map<String, String> errors = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors()
                .forEach(fe -> errors.put(fe.getField(), fe.getDefaultMessage()));
        log.debug("Validation failed for fields {}", errors.keySet());
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, "Validation failed");
        pd.setTitle("Invalid request");
        pd.setProperty("errors", errors);
        return pd;
    }

    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnexpected(Exception ex, HttpServletRequest request) {
        // full stack trace: exception is the last argument
        log.error("Unexpected error on {} {}", request.getMethod(), request.getRequestURI(), ex);
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(
                HttpStatus.INTERNAL_SERVER_ERROR, "An unexpected error occurred");
        pd.setTitle("Internal error");
        return pd;
    }
}
~~~

Notice the client never sees the internal exception message (which could reveal table names or stack details), but our logs have everything, tagged with the request id. In support, the customer gives you the ^X-Request-Id^ from the response header and you find the exact stack trace in seconds.

### Step 7: a custom HealthIndicator

~~~java src/main/java/com/example/bookstore/config/BookCatalogHealthIndicator.java
package com.example.bookstore.config;

import com.example.bookstore.service.BookService;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * Reports whether the catalog can be queried. Name in /actuator/health: "bookCatalog".
 * Included in the readiness group only (never liveness).
 */
@Component
public class BookCatalogHealthIndicator implements HealthIndicator {

    private final BookService bookService;

    public BookCatalogHealthIndicator(BookService bookService) {
        this.bookService = bookService;
    }

    @Override
    public Health health() {
        try {
            long count = bookService.count();
            return Health.up().withDetail("books", count).build();
        } catch (Exception ex) {
            return Health.down().withDetail("error", ex.getClass().getSimpleName()).build();
        }
    }
}
~~~

Health checks are called often (every few seconds by every probe), so they must be **cheap and fast**. A ^count()^ on an indexed table is fine for a course project; on a 50-million-row table you would use something like ^SELECT 1^ or a cached result. Also note we return the exception class name, not its message, to avoid leaking details.

### Step 8: a dev-only bean with @Profile

~~~java src/main/java/com/example/bookstore/config/DevDataConfig.java
package com.example.bookstore.config;

import com.example.bookstore.model.Book;
import com.example.bookstore.repository.BookRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

import java.math.BigDecimal;

@Configuration
@Profile("dev")
public class DevDataConfig {

    private static final Logger log = LoggerFactory.getLogger(DevDataConfig.class);

    @Bean
    CommandLineRunner seedBooks(BookRepository bookRepository) {
        return args -> {
            if (bookRepository.count() > 0) {
                return;
            }
            Book book = new Book();
            book.setTitle("Effective Java");
            book.setIsbn("9780134685991");
            book.setPrice(new BigDecimal("45.00"));
            book.setPublishedYear(2018);
            bookRepository.save(book);
            log.info("Seeded dev database with sample data");
        };
    }
}
~~~

**Under the hood:** ^@Profile^ is a meta-annotation over ^@Conditional(ProfileCondition.class)^. While Spring parses configuration classes, it evaluates the condition against ^Environment.getActiveProfiles()^; if false, the class is skipped and its beans never get a ^BeanDefinition^. You can also negate: ^@Profile("!prod")^.

### Step 9: securing the actuator endpoints

We extend the ^SecurityFilterChain^ from module 4. ^EndpointRequest^ is an Actuator-aware request matcher: it knows the actual endpoint paths, even if you change ^management.endpoints.web.base-path^ or move them to another port. We use a **separate, ordered chain** for actuator so its rules never mix with the API's.

~~~java src/main/java/com/example/bookstore/security/SecurityConfig.java
package com.example.bookstore.security;

import org.springframework.boot.actuate.autoconfigure.security.servlet.EndpointRequest;
import org.springframework.boot.actuate.health.HealthEndpoint;
import org.springframework.boot.actuate.info.InfoEndpoint;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

    /** Chain 1: only actuator endpoints. */
    @Bean
    @Order(1)
    SecurityFilterChain actuatorChain(HttpSecurity http) throws Exception {
        http
            .securityMatcher(EndpointRequest.toAnyEndpoint())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(EndpointRequest.to(HealthEndpoint.class, InfoEndpoint.class)).permitAll()
                .anyRequest().hasRole("ADMIN"))
            .httpBasic(Customizer.withDefaults())
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }

    /** Chain 2: the Bookstore API (as built in module 4). */
    @Bean
    @Order(2)
    SecurityFilterChain apiChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.GET, "/api/books/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults())
            .csrf(csrf -> csrf.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }
}
~~~

The user store (^UserDetailsService^ backed by the users table) stays exactly as in module 4. ^EndpointRequest.to(HealthEndpoint.class, ...)^ also covers sub-paths like ^/actuator/health/liveness^. CSRF is disabled because this is a stateless API with HTTP Basic, as established in module 4.

### Step 10: run and test

Run in dev (the default profile) from PowerShell:

~~~powershell
.\mvnw spring-boot:run
# or explicitly
.\mvnw spring-boot:run "-Dspring-boot.run.profiles=dev"
~~~

The startup log shows ^The following 1 profile is active: "dev"^ and the line ^Seeded dev database with sample data^. Now test (use ^curl.exe^ in PowerShell, because plain ^curl^ is an alias of Invoke-WebRequest in Windows PowerShell 5):

~~~powershell
curl.exe -i http://localhost:8080/api/books/1
curl.exe -i -H "X-Request-Id: demo-12345678" http://localhost:8080/api/books/999
curl.exe http://localhost:8080/actuator/health
curl.exe http://localhost:8080/actuator/health/readiness
curl.exe http://localhost:8080/actuator/info
curl.exe -i http://localhost:8080/actuator/metrics
curl.exe -u admin:admin123 http://localhost:8080/actuator/metrics/http.server.requests
~~~

Expected results:

~~~text
GET /api/books/999  ->  HTTP/1.1 404, header X-Request-Id: demo-12345678
console: 21:04:11.532 WARN  [demo-12345678] c.e.b.e.GlobalExceptionHandler - Not found: Book with id 999 not found

GET /actuator/health (anonymous)  ->  {"status":"UP","groups":["liveness","readiness"]}
GET /actuator/health/readiness    ->  {"status":"UP"}
GET /actuator/metrics (anonymous) ->  HTTP/1.1 401
GET /actuator/metrics/http.server.requests (admin) -> {"name":"http.server.requests","measurements":[{"statistic":"COUNT","value":7.0}, ...]}
~~~

Change a log level at runtime without restarting (admin only):

~~~powershell
curl.exe -u admin:admin123 -X POST -H "Content-Type: application/json" -d '{\"configuredLevel\":\"TRACE\"}' http://localhost:8080/actuator/loggers/com.example.bookstore
~~~

Now simulate production. Build the JAR and run it with the prod profile and environment variables:

~~~powershell
.\mvnw clean package -DskipTests
$env:SPRING_PROFILES_ACTIVE = "prod"
$env:SPRING_DATASOURCE_URL = "jdbc:postgresql://localhost:5432/bookstore"
$env:SPRING_DATASOURCE_USERNAME = "bookstore"
$env:SPRING_DATASOURCE_PASSWORD = "bookstore"
java -jar target\bookstore-0.0.1-SNAPSHOT.jar
~~~

The log now shows ^The following 2 profiles are active: "prod", "json-logs"^ and every line is JSON:

~~~json
{"@timestamp":"2026-11-20T21:10:02.114Z","log":{"level":"INFO","logger":"com.example.bookstore.service.BookService"},"process":{"pid":4120,"thread":{"name":"http-nio-8080-exec-1"}},"service":{"name":"bookstore","environment":"prod"},"message":"Created book id=12 isbn=9781617294945","requestId":"0d6e1c4a-7f2b-4f0b-9a55-1d3c0c8e2f11","ecs":{"version":"8.11"}}
~~~

Actuator now listens on 8081: ^curl.exe http://localhost:8081/actuator/health^. Finally press Ctrl+C and watch graceful shutdown: ^Commencing graceful shutdown. Waiting for active requests to complete^ then ^Graceful shutdown complete^, followed by HikariCP closing its pool. Clean the env vars with ^Remove-Item Env:SPRING_PROFILES_ACTIVE^ when done.

In tests (module 5), activate the test profile with ^@ActiveProfiles("test")^ on your ^@SpringBootTest^ classes, so they use H2 and quiet logging.

---

## 3. Common Pitfalls & Best Practices

- **Mistake:** string concatenation in log calls (^"id " + id^). **Fix:** use ^{}^ placeholders and pass the exception as the last argument to get a stack trace.
- **Mistake:** logging entities, requests or headers wholesale, leaking passwords, tokens or PII. **Fix:** log ids only; review ^toString()^ of records and entities; never log the ^Authorization^ header.
- **Mistake:** exposing all actuator endpoints with ^include: "*"^ on a public port. **Fix:** expose only what you need, permit only ^health^ and ^info^ publicly, require ADMIN for the rest, and consider ^management.server.port^ on an internal network.
- **Mistake:** putting the database check in the liveness probe, causing restart storms during a DB blip. **Fix:** DB and dependencies belong in readiness; liveness checks only the app's own state.
- **Mistake:** committing real passwords in ^application-prod.yml^. **Fix:** use ^§{ENV_VAR}^ placeholders with no default in prod, and inject secrets via env vars, configtree or a secret manager.
- **Mistake:** forgetting ^MDC.remove^ in a finally block, so request ids leak between pooled threads. **Fix:** always clean up MDC in ^finally^ and propagate it explicitly for async work.
- **Mistake:** building a different artifact per environment, or hard-coding ^spring.profiles.active=dev^ inside ^application.yml^. **Fix:** one artifact; choose the profile at runtime with ^SPRING_PROFILES_ACTIVE^; use ^spring.profiles.default^ for local convenience.
- **Mistake:** logging every 404 or validation error at ERROR. **Fix:** ERROR means "our system is broken and someone should act"; client errors are DEBUG or WARN.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Make the Bookstore observable","tasks":["Add the ^RequestIdFilter^ and the dev logging pattern, then call ^GET /api/books/999^ twice: once without and once with an ^X-Request-Id^ header, and confirm the id appears both in the response header and in the console line.","Add ^BookCatalogHealthIndicator^, include it in the readiness group, stop PostgreSQL, and observe what ^/actuator/health/readiness^ and ^/actuator/health/liveness^ return (explain why they differ).","Use the ^/actuator/loggers^ endpoint as admin to switch ^com.example.bookstore^ to TRACE at runtime, then back to INFO, without restarting.","Run the packaged JAR with ^SPRING_PROFILES_ACTIVE=prod^ and confirm in the startup log that both ^prod^ and ^json-logs^ are active and the output is JSON."]},
{"title":"Exercise 2 (Challenge): Metrics and a custom info contributor","tasks":["Inject a Micrometer ^MeterRegistry^ into ^BookService^ via the constructor and add a counter named ^bookstore.books.created^ that increments on every successful create; verify it under ^/actuator/metrics/bookstore.books.created^.","Write an ^InfoContributor^ bean that adds the current number of books and the active profiles to ^/actuator/info^.","Read the Spring Boot reference section on structured logging and switch the prod format from ^ecs^ to ^logstash^; compare the field names of the two outputs.","Add a staging profile that uses JSON logs and a different log level for the ^sql^ group, using only profile groups and no duplicated JSON logging config."]},
{"title":"Exercise 3 (Thinking): Production readiness review","tasks":["Explain in your own words why the database belongs in readiness but not in liveness, and describe what would happen in Kubernetes during a 2-minute database outage if you got it wrong.","List three kinds of data that must never appear in the Bookstore logs and, for each, name the class or place in our code where it could accidentally leak.","Describe the exact order of events during graceful shutdown when a container receives SIGTERM while 3 requests are in flight, and explain why ^spring.lifecycle.timeout-per-shutdown-phase^ must be shorter than the orchestrator's grace period.","Rank these property sources by precedence for ^spring.datasource.password^: a value in ^application-prod.yml^ inside the JAR, an environment variable, and a command-line argument. Justify which one you would use in Docker."]}
]
};
