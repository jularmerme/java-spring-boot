LESSONS['1.1']={
md:String.raw`## 1. Concept & Theory

### The Spring ecosystem

| Project | What it does | Analogy |
|---|---|---|
| **Spring Framework** | Core container (IoC/DI), AOP, transactions, Spring MVC | The engine |
| **Spring Boot** | Auto-configuration, starters, embedded server, Actuator | The car built around the engine |
| **Spring Data** | Repository abstraction for JPA, MongoDB, Redis | Universal database adapter |
| **Spring Security** | Authentication, authorization, attack protection | The security guard |
| **Spring Cloud** | Gateway, config server, discovery, resilience | City infrastructure for many services |

What Boot adds: **starters** (curated dependency bundles), **auto-configuration** (beans created from the classpath and properties), an **embedded server** (ship a runnable JAR with ^java -jar^), and **production features** (health, metrics, externalized config).

### Inversion of Control (IoC)

Traditionally your code creates its own dependencies:

~~~java
class OrderService {
    private final PaymentGateway gateway = new StripeGateway(); // hard-wired
}
~~~

You cannot test this without calling Stripe, and switching to PayPal means editing the class. With **IoC**, a container creates and wires objects. You declare what you need and the framework supplies it ("Don't call us, we'll call you").

### Dependency Injection (DI)

DI is the technique that implements IoC: collaborators are passed in from outside. Spring-managed objects are called **beans**. Without Spring it is just ^new OrderService(new StripeGateway())^. Spring automates that wiring across hundreds of classes.

### BeanFactory vs ApplicationContext

^BeanFactory^ is the basic container. ^ApplicationContext^ extends it with events, environment/property access, and ^@Configuration^ processing. You always use the ^ApplicationContext^.

### What happens at startup

1. ^SpringApplication.run()^ builds the **Environment** (properties, env vars, profiles).
2. It creates the **ApplicationContext**.
3. Component scanning, ^@Configuration^ classes and auto-configurations produce **BeanDefinitions** (recipes, not objects yet).
4. **BeanFactoryPostProcessors** may modify the recipes (e.g. resolve placeholders).
5. Singletons are instantiated in dependency order: constructor, property population, Aware callbacks, BeanPostProcessor "before", ^@PostConstruct^, BeanPostProcessor "after" (**proxies are created here**).
6. The embedded web server starts, ^ApplicationReadyEvent^ fires, then ^CommandLineRunner^ beans run.

Building recipes first is why Spring detects missing beans and cycles at startup instead of at 3 AM in production. **BeanPostProcessor** is the hook behind ^@Autowired^, ^@PostConstruct^ and AOP proxies.

^@SpringBootApplication^ = ^@SpringBootConfiguration^ + ^@EnableAutoConfiguration^ + ^@ComponentScan^.

### Stereotypes

| Annotation | Layer | Extra behavior |
|---|---|---|
| ^@Component^ | Generic | Registers a bean |
| ^@Service^ | Business logic | Documents intent |
| ^@Repository^ | Persistence | Translates DB exceptions to ^DataAccessException^ |
| ^@RestController^ | Web | Handles HTTP (Module 2) |
| ^@Configuration^ | Config | Holds ^@Bean^ methods, CGLIB-proxied |

### Injection types

| Type | Verdict |
|---|---|
| **Constructor** | Preferred: immutable ^final^ fields, explicit required deps, easy to test |
| Setter | Only for optional dependencies |
| Field (^@Autowired private^) | Avoid: hidden deps, no ^final^, needs reflection to test |

With a single constructor, ^@Autowired^ is not needed.

### Bean scopes

| Scope | Instances | Use |
|---|---|---|
| **singleton** (default) | One per container | Stateless services, repositories |
| **prototype** | New one per request to the container | Stateful helpers |
| **request / session** | Per HTTP request / session | Web-only data |

**Production rule:** singletons are shared by all threads. Never store per-user or per-request state in their fields.

### Lifecycle hooks

^@PostConstruct^ runs after injection and ^@PreDestroy^ before shutdown. In Boot 3 they come from ^jakarta.annotation^, not ^javax^.

### @Value vs @ConfigurationProperties

Never hard-code environment-specific values. ^@Value^ suits one or two values. ^@ConfigurationProperties^ binds a group into a typed object with validation, nesting, ^Duration^ and relaxed binding (env var ^APP_MAX_ITEMS^ maps to ^app.max-items^). It is the production standard.

### How auto-configuration works

Boot lists auto-configuration classes in ^META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports^. Each is guarded by conditions:

~~~java
@AutoConfiguration
@ConditionalOnClass(ObjectMapper.class)   // only if Jackson is on the classpath
public class JacksonAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean              // only if YOU have not defined one
    ObjectMapper objectMapper() { ... }
}
~~~

Because of ^@ConditionalOnMissingBean^, your own beans always win. Run with ^--debug^ to print the **Conditions Evaluation Report**.

### Circular dependencies

If A needs B and B needs A, constructor injection fails with "Is there an unresolvable circular reference?". Since Boot 2.6 cycles are prohibited by default. Refactor (extract a third class or use events). Do not set ^spring.main.allow-circular-references=true^.

### Proxies

For ^@Transactional^, ^@Cacheable^ and ^@Async^, Spring gives callers a **proxy** wrapping your bean: begin transaction, call method, commit or roll back. Consequence: **self-invocation bypasses the proxy**. If ^methodA()^ calls ^this.methodB()^, the annotation on ^methodB^ is ignored. We revisit this in Module 3.

---

## 2. Code Walkthrough: Notification and Order mini-app

Create a project at start.spring.io (Maven, Java 21, Boot 3.x, dependency: **Validation**). Structure:

~~~text
src/main/java/com/example/demo/
  DemoApplication.java
  config/        AppConfig.java, AppProperties.java
  notification/  NotificationSender, EmailNotificationSender, SmsNotificationSender,
                 NotificationDispatcher, AlertService
  order/         OrderService, OrderCounter, OrderRequestContext
  lifecycle/     LifecycleDemoBean
src/main/resources/application.yml
~~~

~~~yaml src/main/resources/application.yml
app:
  name: Demo Shop
  max-items-per-order: 5
  notification-timeout: 3s        # converted to java.time.Duration
  support-email: support@demoshop.com
~~~

~~~java src/main/java/com/example/demo/config/AppProperties.java
package com.example.demo.config;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;
import java.time.Duration;

/** Immutable, type-safe config. @Validated makes startup FAIL FAST on bad values. */
@ConfigurationProperties(prefix = "app")
@Validated
public record AppProperties(
        @NotBlank String name,
        @Min(1) int maxItemsPerOrder,     // from "max-items-per-order" (relaxed binding)
        Duration notificationTimeout,     // "3s" becomes Duration.ofSeconds(3)
        @Email String supportEmail
) {}
~~~

~~~java src/main/java/com/example/demo/config/AppConfig.java
package com.example.demo.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import java.time.Clock;

@Configuration
@EnableConfigurationProperties(AppProperties.class) // registers the record as a bean
public class AppConfig {

    /** @Bean is for types you do not own. Injecting a Clock makes time testable. */
    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
~~~

~~~java src/main/java/com/example/demo/notification/NotificationSender.java
package com.example.demo.notification;

public interface NotificationSender {
    String channel();
    void send(String message);
}
~~~

~~~java src/main/java/com/example/demo/notification/EmailNotificationSender.java
package com.example.demo.notification;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(1) // lower number = earlier in an injected List
public class EmailNotificationSender implements NotificationSender {
    @Override public String channel() { return "EMAIL"; }
    @Override public void send(String message) { System.out.println("[EMAIL] " + message); }
}
~~~

~~~java src/main/java/com/example/demo/notification/SmsNotificationSender.java
package com.example.demo.notification;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Component
@Order(2)
public class SmsNotificationSender implements NotificationSender {
    @Override public String channel() { return "SMS"; }
    @Override public void send(String message) { System.out.println("[SMS] " + message); }
}
~~~

~~~java src/main/java/com/example/demo/notification/NotificationDispatcher.java
package com.example.demo.notification;

import java.util.List;
import org.springframework.stereotype.Component;

/** Spring injects EVERY NotificationSender bean, sorted by @Order.
 *  A new channel is just a new @Component: this class never changes (Open/Closed). */
@Component
public class NotificationDispatcher {
    private final List<NotificationSender> senders;

    public NotificationDispatcher(List<NotificationSender> senders) {
        this.senders = List.copyOf(senders);
    }

    public void broadcast(String message) {
        senders.forEach(s -> s.send(message));
    }
}
~~~

~~~java src/main/java/com/example/demo/notification/AlertService.java
package com.example.demo.notification;

import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service
public class AlertService {
    private final NotificationSender sender;

    // Default bean name = decapitalized class name. @Qualifier beats @Primary.
    public AlertService(@Qualifier("smsNotificationSender") NotificationSender sender) {
        this.sender = sender;
    }

    public void raiseAlert(String text) {
        sender.send("ALERT: " + text);
    }
}
~~~

~~~java src/main/java/com/example/demo/order/OrderCounter.java
package com.example.demo.order;

import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/** Singleton shared by all threads, so its mutable state MUST be thread-safe. */
@Component
public class OrderCounter {
    private final AtomicLong value = new AtomicLong(1000);
    public long next() { return value.incrementAndGet(); }
}
~~~

~~~java src/main/java/com/example/demo/order/OrderService.java
package com.example.demo.order;

import com.example.demo.config.AppProperties;
import com.example.demo.notification.NotificationDispatcher;
import java.time.Clock;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
    private final NotificationDispatcher dispatcher;
    private final AppProperties props;
    private final Clock clock;
    private final OrderCounter counter;

    // One constructor: no @Autowired needed. All dependencies final and explicit.
    public OrderService(NotificationDispatcher dispatcher, AppProperties props,
                        Clock clock, OrderCounter counter) {
        this.dispatcher = dispatcher;
        this.props = props;
        this.clock = clock;
        this.counter = counter;
    }

    public void placeOrder(String item, int quantity) {
        if (quantity > props.maxItemsPerOrder()) {
            throw new IllegalArgumentException("Max items per order is " + props.maxItemsPerOrder());
        }
        dispatcher.broadcast("[" + props.name() + "] Order #" + counter.next()
                + ": " + quantity + " x " + item + " at " + clock.instant());
    }
}
~~~

~~~java src/main/java/com/example/demo/order/OrderRequestContext.java
package com.example.demo.order;

import java.util.UUID;
import org.springframework.beans.factory.config.ConfigurableBeanFactory;
import org.springframework.context.annotation.Scope;
import org.springframework.stereotype.Component;

/** Prototype scope: a NEW instance each time the container is asked for one. */
@Component
@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
public class OrderRequestContext {
    private final String id = UUID.randomUUID().toString().substring(0, 8);
    public String id() { return id; }
}
~~~

> Gotcha: a prototype injected into a singleton's constructor is injected ONCE and then behaves like a singleton. Inject ^ObjectProvider<T>^ and call ^getObject()^ to get a fresh one each time.

~~~java src/main/java/com/example/demo/lifecycle/LifecycleDemoBean.java
package com.example.demo.lifecycle;

import com.example.demo.config.AppProperties;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;

@Component
public class LifecycleDemoBean {
    private final AppProperties props;

    public LifecycleDemoBean(AppProperties props) {
        this.props = props;
        System.out.println("1) Constructor called");
    }

    @PostConstruct
    void init() { System.out.println("2) @PostConstruct: starting " + props.name()); }

    @PreDestroy
    void cleanup() { System.out.println("3) @PreDestroy: shutting down cleanly"); }
}
~~~

~~~java src/main/java/com/example/demo/DemoApplication.java
package com.example.demo;

import com.example.demo.notification.AlertService;
import com.example.demo.order.OrderRequestContext;
import com.example.demo.order.OrderService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
public class DemoApplication {

    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }

    @Bean
    CommandLineRunner demo(OrderService orders, AlertService alerts,
                           ObjectProvider<OrderRequestContext> ctx) {
        return args -> {
            orders.placeOrder("Laptop", 1);
            orders.placeOrder("Mouse", 2);
            alerts.raiseAlert("Stock is low on Laptop");
            System.out.println("Context A: " + ctx.getObject().id());
            System.out.println("Context B: " + ctx.getObject().id());
            try { orders.placeOrder("Keyboard", 99); }
            catch (IllegalArgumentException ex) { System.out.println("Error: " + ex.getMessage()); }
        };
    }
}
~~~

### Experiments (this is where understanding happens)

1. Run with ^--debug^ and find the "CONDITIONS EVALUATION REPORT".
2. Set ^max-items-per-order: 0^ and watch the app fail fast at startup.
3. Override from the environment. PowerShell: ^$env:APP_MAX_ITEMS_PER_ORDER=2; .\mvnw spring-boot:run^
4. Make ^OrderService^ and ^NotificationDispatcher^ depend on each other and read the error.
5. Print ^ctx.getBean(AppConfig.class).getClass().getName()^ and notice the CGLIB subclass (^$$SpringCGLIB$$^). That is the proof that Spring wraps your classes.

---

## 3. Common Pitfalls & Best Practices

- **Field injection.** Hidden dependencies, no ^final^, hard to test. Use constructor injection.
- **Mutable state in singletons** (e.g. ^private User currentUser;^ in a service). Threads share it and users see each other's data. Keep services stateless.
- **Classes outside the scan path.** A ^@Component^ outside the main class's package tree is silently ignored.
- **Using ^new^ on a bean.** No injection, no proxies, no ^@Transactional^.
- **Scattered ^@Value^ and hard-coded config.** Use validated ^@ConfigurationProperties^ records.
- **Silencing circular dependencies.** Refactor instead.
- **Heavy work in constructors.** Only assign fields. Use ^@PostConstruct^ or a runner.
- **^javax.*^ imports.** Boot 3 uses ^jakarta.*^.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.`,
exercises:[
 {
  "title": "Exercise 1 (Guided): Build and break the mini-project",
  "tasks": [
   "Generate the project (Maven, Java 21, Boot 3.x, Validation) and recreate all classes.",
   "Run it and match the expected output.",
   "Run the experiments above; write one sentence per experiment on what Spring did and why.",
   "Remove ^@Order^ from both senders and observe the ordering, then add ^@Order(0)^ to SMS so it fires first."
  ]
 },
 {
  "title": "Exercise 2 (Challenge): Add a channel without touching existing code",
  "tasks": [
   "Add ^PushNotificationSender^ (channel PUSH, ^@Order(3)^) with no edits to ^NotificationDispatcher^ or ^OrderService^.",
   "Add ^app.push-enabled^ and guard the sender with ^@ConditionalOnProperty(name=\"app.push-enabled\", havingValue=\"true\")^. Toggle it to prove it works.",
   "Write one paragraph: how does ^@ConditionalOnProperty^ relate to Boot auto-configuration internals?"
  ]
 },
 {
  "title": "Exercise 3 (Challenge): Scope trap",
  "tasks": [
   "Inject ^OrderRequestContext^ directly into ^OrderService^ constructor and print ^id()^ on two orders. Do the ids differ? Explain.",
   "Fix it with ^ObjectProvider<OrderRequestContext>^ and confirm the ids now differ."
  ]
 },
 {
  "title": "Exercise 4 (Thinking): Where does the value belong?",
  "tasks": [
   "Classify as ^@ConfigurationProperties^, ^@Value^ or a constant, and justify: database URL, retry count, Math.PI, feature flag, API secret.",
   "Read \"Externalized Configuration\" in the Spring Boot docs and write the precedence order of command-line args, env vars and application.yml."
  ]
 }
]
};
