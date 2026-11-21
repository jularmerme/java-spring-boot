LESSONS['8.4']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** TaskFlow (package ^com.example.taskflow^) is a well-structured **modular monolith**: ^User^, ^Project^ and ^Task^ entities, JWT security, PostgreSQL with Flyway, Docker Compose (lessons 7.1-7.3), and since lesson 8.3 it publishes ^TaskAssigned^ events through a transactional outbox to RabbitMQ or Kafka, consumed by an idempotent notification handler. In this lesson we ask a hard question: should TaskFlow become microservices? We split it *conceptually* into auth-service, task-service and notification-service, then build a small, runnable multi-module system with Spring Cloud Gateway, Eureka discovery, and declarative HTTP clients, so you understand both the mechanics and the price.

### 1.1 Monolith vs microservices, honestly

A **monolith** is one deployable unit. A **microservice architecture** is a set of independently deployable services, each owning its data, communicating over the network. The analogy: a monolith is one big restaurant kitchen; microservices are a food court of independent stalls. The food court lets the sushi stall change its menu without asking the pizza stall, but now you need shared seating, a payment system, signage, and someone to clean between stalls.

| Dimension | Modular monolith | Microservices |
|---|---|---|
| Deployment | One artifact, one pipeline | Many artifacts, many pipelines |
| Calls between modules | In-process method call (nanoseconds) | Network call (milliseconds, can fail) |
| Transactions | Local ACID transactions | Eventual consistency, sagas |
| Team autonomy | Shared release cadence | Teams deploy independently |
| Scaling | Scale the whole app | Scale hot services individually |
| Technology choice | One stack | Per service (use sparingly) |
| Operational cost | Low | High: discovery, tracing, gateways, many databases |
| Debugging | One log, one stack trace | Distributed tracing required |
| Refactoring boundaries | Easy (IDE refactor) | Hard (API contracts, data migration) |

Microservices are primarily an **organizational** scaling tool. They pay off when many teams step on each other in one codebase, or when parts of the system have radically different scaling, availability or compliance needs. They are not a performance trick: an in-process call is always faster than HTTP.

### 1.2 When NOT to split

- Your team is small (one or two teams). Conway's Law cuts both ways: five services owned by four people is overhead without benefit.
- Your domain boundaries are not yet stable. Wrong boundaries in a monolith cost a refactor; in microservices they cost a distributed rewrite.
- You lack the platform: CI/CD per service, centralized logging, tracing, metrics, automated deployments.
- You want it "because Netflix does it". Netflix has thousands of engineers.
- Features always change several "services" at once. That is a sign they belong together (a distributed monolith is the worst of both worlds).

The recommended path: build a **modular monolith** with strong internal boundaries (packages, no cross-module repository access, in-process events), then extract a service only when a concrete pressure appears. TaskFlow's outbox from lesson 8.3 already gives us the seam for notification-service.

### 1.3 Bounded contexts

Domain-Driven Design's **bounded context** is the unit of a good service boundary: an area where a model and its language are consistent. The word "User" means different things in different contexts:

| Context | What "User" means | Owns |
|---|---|---|
| Identity (auth-service) | Credentials, roles, password hash, login | users table, JWT issuing |
| Work management (task-service) | Someone who can be assigned (id, display name) | projects, tasks |
| Notifications (notification-service) | A contact address and preferences | notification log, preferences |

Each service **owns its data**; no other service reads its tables. task-service stores only the assignee's id and perhaps a cached display name, and learns about user changes via events or an API call.

### 1.4 TaskFlow split conceptually

- **auth-service:** registration, login, issues JWTs signed with a private key, exposes a JWK set so others can verify tokens.
- **task-service:** projects and tasks CRUD, assignment, publishes ^TaskAssigned^ via the outbox.
- **notification-service:** consumes events, sends emails, stores delivery status.
- **gateway:** single public entry point, validates JWTs, routes to services, applies rate limits and CORS.
- **discovery (Eureka):** a registry where instances announce themselves.

For the runnable example we keep it small: gateway + task-service + notification-service + Eureka. The JWT validation at the gateway uses a shared HMAC secret for simplicity, with notes on the production approach (asymmetric keys and JWKS).

### 1.5 Spring Cloud and the release train

Spring Cloud is a set of projects (Gateway, Netflix Eureka, Config, OpenFeign, Circuit Breaker, and others) versioned together as a **release train** named by year. Each train supports specific Spring Boot versions:

| Spring Cloud train | Compatible Spring Boot |
|---|---|
| 2023.0.x (Leyton) | 3.2.x, 3.3.x |
| 2024.0.x (Moorgate) | 3.4.x |
| 2025.0.x (Northfields) | 3.5.x |

For Spring Boot 3.4 we use **2024.0.x** imported as a BOM. Always check the compatibility table on the Spring Cloud project page (spring.io/projects/spring-cloud) before upgrading Boot: a mismatched train fails at startup with a compatibility verifier error, or worse, with obscure ^NoSuchMethodError^ at runtime.

### 1.6 Spring Cloud Gateway under the hood

The gateway (^spring-cloud-starter-gateway^) is a reactive application built on Spring WebFlux and Netty. A request flows through:

1. **Route lookup:** each route has an id, a target URI, a list of **predicates** and a list of **filters**. The ^RoutePredicateHandlerMapping^ finds the first route whose predicates all match (path, method, header, host, time).
1. **Filter chain:** pre-filters run (strip prefix, add header, rate limit, circuit breaker), the request is proxied with Netty's HTTP client, then post-filters modify the response.
1. **Load balancing:** a URI like ^lb://task-service^ makes the ^ReactiveLoadBalancerClientFilter^ ask Spring Cloud LoadBalancer for an instance, which in turn asks the discovery client (Eureka).

Because it is reactive, never call blocking code in a gateway filter. Spring Cloud Gateway also ships a servlet-based variant (Gateway Server MVC); we use the classic reactive one requested by the course, ^spring-cloud-starter-gateway^.

### 1.7 Service discovery with Eureka

In containers and clouds, instances come and go with changing IPs. **Service discovery** solves "where is task-service right now?". Eureka server holds a registry; each Eureka client registers on startup, sends a heartbeat every 30 seconds, and fetches the registry periodically into a local cache. A client calling ^http://task-service/...^ through a ^@LoadBalanced^ client resolves the logical name to a real instance using that cache, round-robin by default.

On **Kubernetes**, you usually do not need Eureka: a Kubernetes Service gives a stable DNS name (^task-service.default.svc^) and kube-proxy load-balances. Eureka shines on VMs, plain Docker, or hybrid environments.

### 1.8 Configuration: Config Server vs environment vs ConfigMaps

| Approach | How it works | Pros | Cons |
|---|---|---|---|
| Environment variables / profiles | Boot reads env vars and YAML at startup | Simple, 12-factor, no extra server | Changes need a restart or redeploy |
| Spring Cloud Config Server | Central server serving properties from Git; clients import via ^spring.config.import=configserver:^ | Versioned config in Git, audit trail, optional refresh | Another critical service to run and secure |
| Kubernetes ConfigMaps and Secrets | Mounted as files or env vars; Boot reads them via ^spring.config.import=configtree:^ or env | Native to the platform, no extra server | Tied to Kubernetes |

The modern default: **env vars plus ConfigMaps/Secrets** on Kubernetes, with secrets in a vault. Config Server remains useful outside Kubernetes or where Git-audited config with many services is valued. We show a minimal Config Server so you recognize it, but the runnable example uses environment variables.

### 1.9 Inter-service communication

| Style | Good for | Watch out for |
|---|---|---|
| Synchronous REST | Queries needing an immediate answer | Temporal coupling, cascading failures, latency chains |
| Asynchronous messaging | Notifying others of facts, long workflows | Eventual consistency, harder debugging |

Rule of thumb: **query synchronously, propagate changes asynchronously.** Each synchronous hop multiplies failure probability: three services each at 99.9 percent availability called in a chain give roughly 99.7 percent. Protect sync calls with timeouts, retries (only for idempotent requests) and circuit breakers (Resilience4j via ^spring-cloud-starter-circuitbreaker-resilience4j^).

### 1.10 Declarative HTTP interfaces with @HttpExchange

Spring Framework 6 introduced **HTTP interface clients**: you declare a Java interface annotated with ^@GetExchange^, ^@PostExchange^ and so on, and ^HttpServiceProxyFactory^ generates an implementation backed by ^RestClient^, ^WebClient^ or ^RestTemplate^. It replaces most uses of OpenFeign with a core-framework feature. Under the hood the factory creates a JDK dynamic proxy; each method call is translated to an HTTP request via the adapter.

### 1.11 Distributed data and sagas

With a database per service, a business operation spanning services cannot use one ACID transaction. A **saga** is a sequence of local transactions, each publishing an event that triggers the next; if a step fails, **compensating actions** undo previous steps.

- **Choreography:** each service listens and reacts (no central coordinator). Simple for 2-3 steps, hard to follow beyond that.
- **Orchestration:** a coordinator tells each participant what to do and tracks state. Clearer for complex flows.

Example: "delete a user" in split TaskFlow. auth-service disables the account and emits ^UserDeactivated^; task-service unassigns their open tasks; notification-service removes preferences. Each step is local, idempotent, and uses the outbox. There is no rollback in the database sense; there is compensation in the business sense.

### 1.12 API versioning

Once services have independent consumers, breaking changes need a strategy:

| Strategy | Example | Notes |
|---|---|---|
| URI path | /api/v1/tasks | Most visible, easy to route at the gateway |
| Header | X-API-Version: 2 | Clean URLs, harder to test in a browser |
| Media type | Accept: application/vnd.taskflow.v2+json | Purist REST, more complex |

Prefer **additive, backward-compatible changes** (new optional fields) so you rarely need a new version. When you must break, run v1 and v2 side by side and route by path at the gateway. Spring Framework 7 / Boot 4 adds first-class API versioning support; on Boot 3.4 we use path prefixes.

---

## 2. Code Walkthrough

We build a new Maven multi-module project ^taskflow-cloud^ next to the monolith. **New modules:** ^discovery-server^, ^gateway^, ^task-service^, ^notification-service^. The services are deliberately tiny (in-memory data) so the focus is on Spring Cloud. In a real migration you would move the TaskFlow ^Task^ code into task-service.

~~~text
taskflow-cloud/
  pom.xml
  docker-compose.yml
  discovery-server/   (Eureka server, port 8761)
  gateway/            (Spring Cloud Gateway, port 8080)
  task-service/       (port 8081)
  notification-service/ (port 8082)
  config-server/      (optional, port 8888)
~~~

### Step 1: Parent POM with the release train BOM

~~~xml taskflow-cloud/pom.xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.4.1</version>
        <relativePath/>
    </parent>

    <groupId>com.example.taskflow</groupId>
    <artifactId>taskflow-cloud</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <packaging>pom</packaging>

    <modules>
        <module>discovery-server</module>
        <module>gateway</module>
        <module>task-service</module>
        <module>notification-service</module>
        <module>config-server</module>
    </modules>

    <properties>
        <java.version>21</java.version>
        <spring-cloud.version>2024.0.0</spring-cloud.version>
    </properties>

    <dependencyManagement>
        <dependencies>
            <dependency>
                <groupId>org.springframework.cloud</groupId>
                <artifactId>spring-cloud-dependencies</artifactId>
                <version>§{spring-cloud.version}</version>
                <type>pom</type>
                <scope>import</scope>
            </dependency>
        </dependencies>
    </dependencyManagement>

    <build>
        <pluginManagement>
            <plugins>
                <plugin>
                    <groupId>org.springframework.boot</groupId>
                    <artifactId>spring-boot-maven-plugin</artifactId>
                </plugin>
            </plugins>
        </pluginManagement>
    </build>
</project>
~~~

Use the latest 2024.0.x patch release; check the compatibility table. The Maven property placeholder above is written with the section sign in this course and becomes the normal Maven syntax.

### Step 2: Eureka discovery server

~~~xml taskflow-cloud/discovery-server/pom.xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example.taskflow</groupId>
        <artifactId>taskflow-cloud</artifactId>
        <version>0.0.1-SNAPSHOT</version>
    </parent>
    <artifactId>discovery-server</artifactId>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-server</artifactId>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
~~~

~~~java taskflow-cloud/discovery-server/src/main/java/com/example/taskflow/discovery/DiscoveryServerApplication.java
package com.example.taskflow.discovery;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.netflix.eureka.server.EnableEurekaServer;

@SpringBootApplication
@EnableEurekaServer
public class DiscoveryServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(DiscoveryServerApplication.class, args);
    }
}
~~~

~~~yaml taskflow-cloud/discovery-server/src/main/resources/application.yml
server:
  port: 8761

spring:
  application:
    name: discovery-server

eureka:
  client:
    register-with-eureka: false
    fetch-registry: false
  server:
    enable-self-preservation: false   # dev only; keep true in production
~~~

A single server does not register with itself. In production you run two or three Eureka peers that replicate to each other. **Self-preservation** stops Eureka from evicting instances when many heartbeats fail at once (it assumes a network problem, not mass death); disabling it in dev makes dead instances disappear quickly.

### Step 3: task-service with a load-balanced RestClient and @HttpExchange

Every service module has the same kind of POM; here is task-service:

~~~xml taskflow-cloud/task-service/pom.xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example.taskflow</groupId>
        <artifactId>taskflow-cloud</artifactId>
        <version>0.0.1-SNAPSHOT</version>
    </parent>
    <artifactId>task-service</artifactId>

    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-validation</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
~~~

The notification-service POM is identical except for ^<artifactId>notification-service</artifactId>^.

~~~java taskflow-cloud/task-service/src/main/java/com/example/taskflow/task/TaskServiceApplication.java
package com.example.taskflow.task;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class TaskServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(TaskServiceApplication.class, args);
    }
}
~~~

No ^@EnableDiscoveryClient^ needed: having the Eureka client starter on the classpath is enough; auto-configuration registers the instance.

The declarative client for notification-service:

~~~java taskflow-cloud/task-service/src/main/java/com/example/taskflow/task/client/NotificationClient.java
package com.example.taskflow.task.client;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.PostExchange;

import java.util.List;

@HttpExchange("/api/v1/notifications")
public interface NotificationClient {

    @PostExchange
    NotificationResponse send(@RequestBody NotificationRequest request);

    @GetExchange("/user/{userId}")
    List<NotificationResponse> forUser(@PathVariable Long userId);

    record NotificationRequest(Long userId, String message) {
    }

    record NotificationResponse(Long id, Long userId, String message, String status) {
    }
}
~~~

~~~java taskflow-cloud/task-service/src/main/java/com/example/taskflow/task/config/HttpClientConfig.java
package com.example.taskflow.task.config;

import com.example.taskflow.task.client.NotificationClient;
import org.springframework.cloud.client.loadbalancer.LoadBalanced;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.support.RestClientAdapter;
import org.springframework.web.service.invoker.HttpServiceProxyFactory;

@Configuration
public class HttpClientConfig {

    /**
     * @LoadBalanced makes Spring Cloud add an interceptor to every RestClient
     * built from this builder. It resolves "http://notification-service" via Eureka.
     */
    @Bean
    @LoadBalanced
    RestClient.Builder loadBalancedRestClientBuilder() {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(2_000);
        factory.setReadTimeout(3_000);
        return RestClient.builder().requestFactory(factory);
    }

    @Bean
    NotificationClient notificationClient(RestClient.Builder loadBalancedRestClientBuilder) {
        RestClient restClient = loadBalancedRestClientBuilder
                .baseUrl("http://notification-service")
                .build();
        return HttpServiceProxyFactory
                .builderFor(RestClientAdapter.create(restClient))
                .build()
                .createClient(NotificationClient.class);
    }
}
~~~

We configure timeouts directly with ^SimpleClientHttpRequestFactory^. **Under the hood:** Spring Cloud Commons has a bean post-processor that finds ^RestClient.Builder^ beans marked ^@LoadBalanced^ and adds a ^LoadBalancerInterceptor^. When a request goes to host ^notification-service^, the interceptor asks the ^LoadBalancerClient^ for an instance (backed by Eureka's cached registry) and rewrites the URI to the real host and port. Timeouts are non-negotiable: the default is effectively infinite, and one slow service can exhaust every thread upstream.

Now the domain and controller (in memory for brevity):

~~~java taskflow-cloud/task-service/src/main/java/com/example/taskflow/task/api/TaskDtos.java
package com.example.taskflow.task.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

public final class TaskDtos {

    private TaskDtos() {
    }

    public record CreateTaskRequest(@NotBlank String title, @NotNull @Positive Long projectId) {
    }

    public record AssignRequest(@NotNull @Positive Long assigneeId) {
    }

    public record TaskResponse(Long id, String title, Long projectId, Long assigneeId) {
    }
}
~~~

~~~java taskflow-cloud/task-service/src/main/java/com/example/taskflow/task/api/TaskController.java
package com.example.taskflow.task.api;

import com.example.taskflow.task.api.TaskDtos.AssignRequest;
import com.example.taskflow.task.api.TaskDtos.CreateTaskRequest;
import com.example.taskflow.task.api.TaskDtos.TaskResponse;
import com.example.taskflow.task.client.NotificationClient;
import com.example.taskflow.task.client.NotificationClient.NotificationRequest;
import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

import java.util.Collection;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@RestController
@RequestMapping("/api/v1/tasks")
public class TaskController {

    private static final Logger log = LoggerFactory.getLogger(TaskController.class);

    private final Map<Long, TaskResponse> tasks = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final NotificationClient notificationClient;

    public TaskController(NotificationClient notificationClient) {
        this.notificationClient = notificationClient;
    }

    @GetMapping
    public Collection<TaskResponse> all() {
        return tasks.values();
    }

    @GetMapping("/{id}")
    public TaskResponse one(@PathVariable Long id) {
        return find(id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public TaskResponse create(@Valid @RequestBody CreateTaskRequest request,
                               @RequestHeader("X-User-Id") String userId) {
        long id = ids.incrementAndGet();
        var task = new TaskResponse(id, request.title(), request.projectId(), null);
        tasks.put(id, task);
        log.info("User {} created task {}", userId, id);
        return task;
    }

    @PutMapping("/{id}/assignee")
    public ResponseEntity<TaskResponse> assign(@PathVariable Long id, @Valid @RequestBody AssignRequest request) {
        var current = find(id);
        var updated = new TaskResponse(current.id(), current.title(), current.projectId(), request.assigneeId());
        tasks.put(id, updated);

        // Demo of a synchronous call. In production prefer the outbox + broker from lesson 8.3.
        try {
            notificationClient.send(new NotificationRequest(request.assigneeId(),
                    "You were assigned task #" + id + " '" + current.title() + "'"));
        } catch (RestClientException e) {
            log.warn("Notification failed, assignment kept: {}", e.getMessage());
        }
        return ResponseEntity.ok(updated);
    }

    private TaskResponse find(Long id) {
        var task = tasks.get(id);
        if (task == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Task " + id + " not found");
        }
        return task;
    }
}
~~~

Note the deliberate choice: if notification fails, the assignment still succeeds. A failing side effect must not fail the core operation. That is exactly the argument for messaging from lesson 8.3.

~~~yaml taskflow-cloud/task-service/src/main/resources/application.yml
server:
  port: 8081

spring:
  application:
    name: task-service

eureka:
  client:
    service-url:
      defaultZone: §{EUREKA_URL:http://localhost:8761/eureka}
  instance:
    prefer-ip-address: true

management:
  endpoints:
    web:
      exposure:
        include: health,info
~~~

^spring.application.name^ is the logical service id that registers with Eureka and that clients use in ^lb://task-service^.

### Step 4: notification-service

~~~java taskflow-cloud/notification-service/src/main/java/com/example/taskflow/notification/NotificationServiceApplication.java
package com.example.taskflow.notification;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class NotificationServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(NotificationServiceApplication.class, args);
    }
}
~~~

~~~java taskflow-cloud/notification-service/src/main/java/com/example/taskflow/notification/NotificationController.java
package com.example.taskflow.notification;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

    private static final Logger log = LoggerFactory.getLogger(NotificationController.class);

    public record NotificationRequest(@NotNull Long userId, @NotBlank String message) {
    }

    public record NotificationResponse(Long id, Long userId, String message, String status) {
    }

    private final List<NotificationResponse> store = new CopyOnWriteArrayList<>();
    private final AtomicLong ids = new AtomicLong();
    private final String instanceId;

    public NotificationController(@Value("§{HOSTNAME:local}") String instanceId) {
        this.instanceId = instanceId;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public NotificationResponse send(@Valid @RequestBody NotificationRequest request) {
        var n = new NotificationResponse(ids.incrementAndGet(), request.userId(), request.message(), "SENT");
        store.add(n);
        log.info("[{}] notify user {}: {}", instanceId, request.userId(), request.message());
        return n;
    }

    @GetMapping("/user/{userId}")
    public List<NotificationResponse> forUser(@PathVariable Long userId) {
        return store.stream().filter(n -> n.userId().equals(userId)).toList();
    }
}
~~~

Logging ^HOSTNAME^ (the container id in Docker) lets you see load balancing in action when you scale to two instances.

~~~yaml taskflow-cloud/notification-service/src/main/resources/application.yml
server:
  port: 8082

spring:
  application:
    name: notification-service

eureka:
  client:
    service-url:
      defaultZone: §{EUREKA_URL:http://localhost:8761/eureka}
  instance:
    prefer-ip-address: true
~~~

### Step 5: The gateway with routes, predicates, filters and JWT validation

~~~xml taskflow-cloud/gateway/pom.xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>com.example.taskflow</groupId>
        <artifactId>taskflow-cloud</artifactId>
        <version>0.0.1-SNAPSHOT</version>
    </parent>
    <artifactId>gateway</artifactId>

    <dependencies>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-gateway</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.cloud</groupId>
            <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
        </plugins>
    </build>
</project>
~~~

Do **not** add ^spring-boot-starter-web^ to the gateway: it is WebFlux-based, and having Spring MVC on the classpath makes it fail at startup.

~~~java taskflow-cloud/gateway/src/main/java/com/example/taskflow/gateway/GatewayApplication.java
package com.example.taskflow.gateway;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class GatewayApplication {

    public static void main(String[] args) {
        SpringApplication.run(GatewayApplication.class, args);
    }
}
~~~

Routes in YAML. Each route: ^id^, ^uri^, ^predicates^, ^filters^.

~~~yaml taskflow-cloud/gateway/src/main/resources/application.yml
server:
  port: 8080

spring:
  application:
    name: gateway
  cloud:
    gateway:
      default-filters:
        - AddResponseHeader=X-Gateway, taskflow
        - DedupeResponseHeader=Access-Control-Allow-Origin
      routes:
        - id: task-service
          uri: lb://task-service
          predicates:
            - Path=/api/v1/tasks/**
          filters:
            - name: Retry
              args:
                retries: 2
                methods: GET
                statuses: BAD_GATEWAY,SERVICE_UNAVAILABLE
        - id: notification-service
          uri: lb://notification-service
          predicates:
            - Path=/api/v1/notifications/**
            - Method=GET
        - id: task-service-legacy
          uri: lb://task-service
          predicates:
            - Path=/api/tasks/**
          filters:
            - RewritePath=/api/tasks/(?<rest>.*), /api/v1/tasks/§{rest}

eureka:
  client:
    service-url:
      defaultZone: §{EUREKA_URL:http://localhost:8761/eureka}

taskflow:
  jwt:
    secret: §{JWT_SECRET:change-me-to-a-long-random-secret-at-least-32-bytes}

management:
  endpoints:
    web:
      exposure:
        include: health,info,gateway
~~~

Notes:

- ^lb://task-service^ triggers load balancing via Eureka.
- The ^Retry^ filter only retries GETs: retrying a POST could create duplicates.
- The notification route only allows GET from outside; POST is internal (service to service).
- The legacy route shows **API versioning at the gateway**: old clients calling ^/api/tasks^ are rewritten to v1. In the RewritePath replacement the gateway uses its own placeholder syntax, written here with the section sign.
- ^/actuator/gateway/routes^ lists the active routes, great for debugging.

Now JWT validation. The gateway is a resource server: Spring Security WebFlux validates the bearer token's signature and expiry before any route runs. Then a global filter forwards the user id to downstream services as a header, and strips any spoofed incoming one.

~~~java taskflow-cloud/gateway/src/main/java/com/example/taskflow/gateway/SecurityConfig.java
package com.example.taskflow.gateway;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder;
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder;
import org.springframework.security.web.server.SecurityWebFilterChain;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;

@Configuration
@EnableWebFluxSecurity
public class SecurityConfig {

    @Bean
    SecurityWebFilterChain securityWebFilterChain(ServerHttpSecurity http) {
        return http
                .csrf(ServerHttpSecurity.CsrfSpec::disable)
                .authorizeExchange(ex -> ex
                        .pathMatchers("/actuator/health").permitAll()
                        .pathMatchers(HttpMethod.POST, "/api/v1/auth/**").permitAll()
                        .anyExchange().authenticated())
                .oauth2ResourceServer(oauth -> oauth.jwt(jwt -> { }))
                .build();
    }

    @Bean
    ReactiveJwtDecoder jwtDecoder(@Value("§{taskflow.jwt.secret}") String secret) {
        var key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        return NimbusReactiveJwtDecoder.withSecretKey(key)
                .macAlgorithm(MacAlgorithm.HS256)
                .build();
    }
}
~~~

^javax.crypto^ is part of the JDK, not the old Java EE ^javax^ namespace, so it is correct here. In production, auth-service signs with an RSA or EC private key and publishes a JWK set; the gateway then uses ^spring.security.oauth2.resourceserver.jwt.jwk-set-uri^ and no secret is shared.

~~~java taskflow-cloud/gateway/src/main/java/com/example/taskflow/gateway/UserHeaderFilter.java
package com.example.taskflow.gateway;

import org.springframework.cloud.gateway.filter.GatewayFilterChain;
import org.springframework.cloud.gateway.filter.GlobalFilter;
import org.springframework.core.Ordered;
import org.springframework.security.core.context.ReactiveSecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;

/**
 * Removes any client-supplied X-User-Id header, then adds the subject of the
 * validated JWT. Downstream services can trust this header ONLY because they
 * are not reachable from outside except through the gateway.
 */
@Component
public class UserHeaderFilter implements GlobalFilter, Ordered {

    public static final String USER_HEADER = "X-User-Id";

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        return ReactiveSecurityContextHolder.getContext()
                .map(ctx -> ctx.getAuthentication())
                .filter(JwtAuthenticationToken.class::isInstance)
                .cast(JwtAuthenticationToken.class)
                .map(auth -> exchange.mutate()
                        .request(r -> r.headers(h -> {
                            h.remove(USER_HEADER);
                            h.add(USER_HEADER, auth.getToken().getSubject());
                        }))
                        .build())
                .defaultIfEmpty(exchange.mutate()
                        .request(r -> r.headers(h -> h.remove(USER_HEADER)))
                        .build())
                .flatMap(chain::filter);
    }

    @Override
    public int getOrder() {
        return Ordered.HIGHEST_PRECEDENCE + 10;
    }
}
~~~

**Defense in depth:** validating at the gateway is efficient, but in a zero-trust network each service should also validate the token (each becomes a resource server too). Trusting a header is acceptable only when the network guarantees services are unreachable directly.

### Step 6: Optional Spring Cloud Config Server

~~~java taskflow-cloud/config-server/src/main/java/com/example/taskflow/config/ConfigServerApplication.java
package com.example.taskflow.config;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.config.server.EnableConfigServer;

@SpringBootApplication
@EnableConfigServer
public class ConfigServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ConfigServerApplication.class, args);
    }
}
~~~

~~~yaml taskflow-cloud/config-server/src/main/resources/application.yml
server:
  port: 8888

spring:
  application:
    name: config-server
  cloud:
    config:
      server:
        git:
          uri: https://github.com/your-org/taskflow-config
          default-label: main
~~~

The config-server POM uses ^spring-cloud-config-server^. A client adds ^spring-cloud-starter-config^ and one line, ^spring.config.import: optional:configserver:http://config-server:8888^; Boot then fetches ^task-service.yml^ and ^task-service-prod.yml^ from the Git repo at startup. On Kubernetes, the equivalent is a ConfigMap mounted at ^/etc/config^ and ^spring.config.import: optional:configtree:/etc/config/^, with no server to operate. We leave config-server out of the compose file to keep the example lean.

### Step 7: Dockerfile and docker-compose

One multi-stage Dockerfile builds any module, selected by a build argument:

~~~dockerfile taskflow-cloud/Dockerfile
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY . .
ARG MODULE
RUN ./mvnw -q -pl $MODULE -am package -DskipTests

FROM eclipse-temurin:21-jre
ARG MODULE
WORKDIR /app
COPY --from=build /src/$MODULE/target/*.jar app.jar
RUN useradd -r spring
USER spring
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
~~~

~~~yaml taskflow-cloud/docker-compose.yml
services:
  discovery-server:
    build:
      context: .
      args:
        MODULE: discovery-server
    ports:
      - "8761:8761"
    healthcheck:
      test: ["CMD-SHELL", "bash -c 'echo > /dev/tcp/localhost/8761'"]
      interval: 5s
      retries: 20

  task-service:
    build:
      context: .
      args:
        MODULE: task-service
    environment:
      EUREKA_URL: http://discovery-server:8761/eureka
    depends_on:
      discovery-server:
        condition: service_healthy

  notification-service:
    build:
      context: .
      args:
        MODULE: notification-service
    environment:
      EUREKA_URL: http://discovery-server:8761/eureka
    depends_on:
      discovery-server:
        condition: service_healthy

  gateway:
    build:
      context: .
      args:
        MODULE: gateway
    ports:
      - "8080:8080"
    environment:
      EUREKA_URL: http://discovery-server:8761/eureka
      JWT_SECRET: §{JWT_SECRET:-change-me-to-a-long-random-secret-at-least-32-bytes}
    depends_on:
      discovery-server:
        condition: service_healthy
~~~

Only the gateway and the Eureka dashboard publish ports. task-service and notification-service are reachable only on the internal compose network, which is what makes the ^X-User-Id^ header trustworthy.

### Step 8: Run it

~~~powershell
cd taskflow-cloud
docker compose up -d --build --scale notification-service=2
# wait about 30-60 seconds for registrations, then open http://localhost:8761
~~~

Create a test token. For the lab, generate an HS256 JWT with subject ^7^ signed with the secret above (for example with a small JUnit helper using Nimbus, or with the TaskFlow auth endpoint from lesson 7.2 if you point it at the same secret).

~~~powershell
$token = "<paste HS256 JWT here>"
$h = @{Authorization = "Bearer $token"}
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/v1/tasks -Headers $h -ContentType "application/json" -Body '{"title":"Split the monolith","projectId":1}'
Invoke-RestMethod -Method Put -Uri http://localhost:8080/api/v1/tasks/1/assignee -Headers $h -ContentType "application/json" -Body '{"assigneeId":2}'
Invoke-RestMethod -Uri http://localhost:8080/api/v1/notifications/user/2 -Headers $h
Invoke-WebRequest -Uri http://localhost:8080/api/v1/tasks | Select-Object StatusCode
~~~

Expected results:

~~~text
id title              projectId assigneeId
-- -----              --------- ----------
 1 Split the monolith         1

 1 Split the monolith         1          2

id userId message                                        status
-- ------ -------                                        ------
 1      2 You were assigned task #1 'Split the monolith' SENT

Invoke-WebRequest : The remote server returned an error: (401) Unauthorized.
~~~

Interesting detail: with two notification instances, the GET may land on the instance that did *not* store the notification and return an empty list. That is a real lesson: in-memory state plus load balancing equals inconsistent reads. Real services keep state in their own database. Check ^docker compose logs notification-service^ to see which instance handled each request.

---

## 3. Common Pitfalls & Best Practices

- **Splitting too early or along technical layers.** Fix: start with a modular monolith; split along bounded contexts when team or scaling pressure is real.
- **Sharing a database between services.** Fix: each service owns its schema; integrate through APIs and events, never through another service's tables.
- **Mismatched Spring Cloud and Spring Boot versions.** Fix: import the matching release train BOM (2024.0.x for Boot 3.4) and check the compatibility table on every upgrade.
- **Adding spring-boot-starter-web to the gateway, or blocking inside gateway filters.** Fix: the reactive gateway uses WebFlux only; keep filters non-blocking.
- **No timeouts, retries on non-idempotent calls, long synchronous chains.** Fix: set connect/read timeouts, retry only safe methods, add circuit breakers, and prefer events for propagating changes.
- **Trusting identity headers from clients.** Fix: the gateway strips and re-sets them, services are not publicly reachable, and ideally each service validates the JWT itself.
- **Distributed transactions with 2PC.** Fix: use sagas with local transactions, the outbox pattern, idempotent steps and explicit compensations.
- **Breaking API changes without versioning.** Fix: make additive changes, version by path when breaking, and route old versions at the gateway until clients migrate.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.`,
exercises:[
{"title":"Exercise 1 (Guided): Extend the gateway setup","tasks":["Add a third small service ^project-service^ (port 8083) with ^GET /api/v1/projects/{id}^ that registers with Eureka, and add a gateway route for it.","Add a ^RequestRateLimiter^ or a simple custom ^GlobalFilter^ that logs method, path, status and duration for every request.","Scale task-service to two instances and verify in the Eureka dashboard and the logs that the gateway balances requests across both.","Call ^/actuator/gateway/routes^ on the gateway and explain each part of one route in your own words."]},
{"title":"Exercise 2 (Challenge): Resilience and messaging","tasks":["Add ^spring-cloud-starter-circuitbreaker-resilience4j^ to task-service and wrap the ^NotificationClient^ call in a circuit breaker with a fallback; stop notification-service and observe the breaker opening.","Replace the synchronous notification call with the outbox + RabbitMQ approach from lesson 8.3, adding RabbitMQ to the compose file.","Read the Spring Security reference on resource servers and change the gateway to validate RS256 tokens from a ^jwk-set-uri^ exposed by a minimal auth-service.","Make task-service also validate the JWT itself (defense in depth) and confirm a direct call without a token is rejected with 401."]},
{"title":"Exercise 3 (Thinking): Should TaskFlow split?","tasks":["Write a one-page decision record arguing whether TaskFlow, with a team of three developers, should be split today. Use at least five criteria from the lesson.","Design the saga for deleting a project that spans task-service and notification-service: list each local transaction, event and compensation.","Compare running TaskFlow on Kubernetes with Kubernetes Services and ConfigMaps versus Eureka and Config Server: which components disappear and what you gain or lose.","List three new failure modes introduced by the gateway and discovery server and how you would detect each in production."]}
]
};
