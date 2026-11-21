LESSONS['8.3']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** After lessons 7.1-7.3 the TaskFlow capstone (package ^com.example.taskflow^) has three JPA entities (^User^, ^Project^, ^Task^), stateless JWT security, PostgreSQL with Flyway migrations, and a Docker Compose file that starts the database and the app. Assigning a task is a synchronous REST call: ^PUT /api/tasks/{id}/assignee^ updates a row and returns 200. In this lesson we make TaskFlow **event-driven**: when a task is assigned we publish a ^TaskAssigned^ event, and a notification consumer reacts to it, reliably, using the Transactional Outbox pattern. We implement the broker side twice, once with RabbitMQ and once with Kafka, so you can feel the difference.

### 1.1 Why asynchronous messaging?

Imagine a restaurant. The waiter takes your order and pins a ticket on the kitchen rail. The waiter does not stand in the kitchen waiting for your steak; they go serve other tables. The ticket rail is a **message queue**: it decouples the producer (waiter) from the consumer (cook) in **time** (the cook can be busy), in **space** (the waiter does not need to know which cook), and in **load** (ten tickets can pile up during a rush and be worked off later).

In TaskFlow, assigning a task should trigger several side effects: send an email, push a websocket notification, update a search index, write an audit entry. If the REST controller does all of that synchronously:

- Latency adds up: the user waits for the SMTP server.
- Failure couples: if the email provider is down, task assignment fails, even though the core business fact (the assignment) is perfectly valid.
- Every new side effect means editing the task code (tight coupling).

With messaging, the task service records the fact "task 42 was assigned to user 7" and publishes an **event**. Anyone interested subscribes. The producer does not know or care how many consumers exist.

| Concern | Synchronous REST call | Asynchronous message |
|---|---|---|
| Caller latency | Sum of all downstream calls | Just the publish (milliseconds) |
| Downstream outage | Caller fails or must retry inline | Messages wait in the broker |
| Adding a new reaction | Change the caller | Add a new subscriber |
| Consistency | Immediate | Eventual |
| Debugging | Single stack trace | Distributed, needs correlation IDs |

The honest cost: **eventual consistency** and more moving parts. Messaging is a tool for side effects and integration, not a replacement for every method call.

### 1.2 Commands vs events

A **command** says "do this" (^SendEmail^) and normally has exactly one handler. An **event** says "this happened" (^TaskAssigned^), is named in the past tense, and can have zero or many handlers. Prefer publishing events from your domain: they describe facts and do not presume what others do with them.

### 1.3 Queues vs topics/logs

There are two broad broker models, and RabbitMQ and Kafka sit at opposite ends.

| Aspect | Queue (RabbitMQ) | Log (Kafka) |
|---|---|---|
| Storage model | Messages removed once acknowledged | Append-only log, retained by time/size |
| Consumer position | Broker tracks per message | Consumer tracks an offset per partition |
| Replay old messages | No (once consumed, gone) | Yes, reset the offset |
| Routing | Rich: exchanges, routing keys, bindings | Simple: topic + partition by key |
| Fan-out | One queue per subscriber, bound to an exchange | Each consumer group reads the whole topic |
| Ordering | Per queue, single consumer | Per partition |
| Throughput sweet spot | Tens of thousands msg/s | Hundreds of thousands to millions msg/s |
| Typical use | Task distribution, RPC-like workflows | Event streaming, analytics, event sourcing |

**RabbitMQ** under the hood: a producer never writes to a queue directly. It publishes to an **exchange** with a **routing key**. **Bindings** connect exchanges to queues with a pattern. A ^topic^ exchange matches routing keys like ^task.assigned^ against patterns like ^task.*^. Consumers read from queues; when a consumer **acks** a message, RabbitMQ deletes it.

**Kafka** under the hood: a **topic** is split into **partitions**; each partition is an ordered, immutable log on disk, replicated across brokers. A producer sends a record with an optional **key**; the default partitioner hashes the key, so all events for the same key land in the same partition and keep their order. Consumers join a **consumer group**; Kafka assigns each partition to exactly one consumer in the group, and the consumer periodically **commits its offset** (its position). Different groups read independently, which is how fan-out works.

### 1.4 Delivery guarantees

Networks fail between "broker delivered" and "consumer acknowledged". Every system picks a point on this spectrum:

| Guarantee | How it happens | Risk |
|---|---|---|
| At-most-once | Ack before processing | Message lost if consumer crashes mid-processing |
| At-least-once | Ack after successful processing | Duplicate if the crash happens after processing but before ack |
| Exactly-once | Transactions spanning read, process, write | Only within one system (e.g. Kafka-to-Kafka) |

The production truth: **design for at-least-once and make consumers idempotent.** Kafka offers exactly-once semantics for read-process-write *inside Kafka*, but the moment your consumer sends an email or writes to PostgreSQL, you are back to at-least-once. An **idempotent consumer** produces the same result if it handles a message twice. The standard technique: every event carries a unique ^eventId^, and the consumer records processed IDs in a table with a unique constraint inside the same database transaction as its side effect. A duplicate hits the constraint and is skipped.

### 1.5 In-process events: Spring ApplicationEvent

Before reaching for a broker, know that Spring has a built-in event bus. You call ^ApplicationEventPublisher.publishEvent(obj)^ and any bean method annotated with ^@EventListener^ or ^@TransactionalEventListener^ receives it. Under the hood, the ^ApplicationContext^ keeps a multicaster that looks up listeners by the event's type and invokes them, synchronously by default, on the same thread.

^@TransactionalEventListener(phase = AFTER_COMMIT)^ is especially useful: Spring registers a transaction synchronization and invokes the listener only after the surrounding transaction commits, so you never react to a change that was rolled back.

| | ApplicationEvent | Message broker |
|---|---|---|
| Scope | One JVM | Across services |
| Survives a crash | No, lost from memory | Yes, persisted |
| Infrastructure | None | Broker cluster |
| Good for | Decoupling modules inside a monolith | Integration between services, durable work |

We will actually use an in-process event too: it is a clean way to let the outbox writer stay separate from the ^TaskService^.

### 1.6 The dual-write problem

Here is the trap almost every team falls into:

~~~java
@Transactional
public void assign(Long taskId, Long userId) {
    task.setAssignee(user);          // 1. write to PostgreSQL
    rabbitTemplate.convertAndSend(...); // 2. write to the broker
}
~~~

Two systems, no shared transaction. Failure scenarios:

- The broker publish succeeds, then the DB commit fails: consumers get an event about an assignment that never happened.
- The DB commits, then the app crashes before publishing: the assignment happened but nobody is notified, forever.

Distributed transactions (XA/2PC) are slow, poorly supported by brokers, and operationally painful. The industry answer is the **Transactional Outbox**: in the *same* database transaction as the business change, insert the event into an ^outbox_event^ table. A separate **relay** reads unpublished rows, publishes them to the broker, and marks them as published. If the relay crashes after publishing but before marking, the row is published again: at-least-once, which our idempotent consumer handles. The database is the single source of truth.

The relay can be a polling scheduler (what we build, simple and good to thousands of events per second) or change-data-capture with Debezium reading the PostgreSQL write-ahead log (lower latency, more infrastructure).

### 1.7 Choosing RabbitMQ or Kafka

- Choose **RabbitMQ** when you need flexible routing, per-message acknowledgment, work queues, priority, delayed retries, and modest throughput. It is simpler to run and reason about.
- Choose **Kafka** when you need high throughput, replay, long retention, many independent consumers of the same stream, strict per-key ordering, or stream processing.
- Do not run both unless you have a reason. For TaskFlow alone, RabbitMQ is plenty; we show Kafka because you will meet it in industry.

---

## 2. Code Walkthrough

**New files:** ^V5__outbox_and_processed_events.sql^, ^events/TaskAssignedEvent.java^, ^outbox/OutboxEvent.java^, ^outbox/OutboxRepository.java^, ^outbox/OutboxWriter.java^, ^outbox/OutboxRelay.java^, ^outbox/EventPublisher.java^, ^messaging/rabbit/RabbitConfig.java^, ^messaging/rabbit/RabbitEventPublisher.java^, ^messaging/kafka/KafkaConfig.java^, ^messaging/kafka/KafkaEventPublisher.java^, ^notification/ProcessedEvent.java^, ^notification/ProcessedEventRepository.java^, ^notification/NotificationService.java^, two listeners and a test. **Changed files:** ^pom.xml^, ^application.yml^, ^TaskService.java^, ^TaskflowApplication.java^, ^docker-compose.yml^.

We use a property ^taskflow.messaging.broker^ (^rabbit^ or ^kafka^) to switch the broker, so both implementations live in the codebase without conflicting.

### Step 1: Dependencies

~~~xml pom.xml (dependencies section, additions only)
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-amqp</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.kafka</groupId>
    <artifactId>spring-kafka</artifactId>
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
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>rabbitmq</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>kafka</artifactId>
    <scope>test</scope>
</dependency>
<dependency>
    <groupId>org.awaitility</groupId>
    <artifactId>awaitility</artifactId>
    <scope>test</scope>
</dependency>
~~~

Versions come from the Spring Boot parent BOM, so no version tags are needed. Jackson is already on the classpath via the web starter.

### Step 2: The Flyway migration

~~~sql src/main/resources/db/migration/V5__outbox_and_processed_events.sql
CREATE TABLE outbox_event (
    id             UUID PRIMARY KEY,
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id   VARCHAR(100) NOT NULL,
    event_type     VARCHAR(100) NOT NULL,
    payload        JSONB        NOT NULL,
    created_at     TIMESTAMPTZ  NOT NULL,
    published_at   TIMESTAMPTZ
);

CREATE INDEX idx_outbox_unpublished
    ON outbox_event (created_at)
    WHERE published_at IS NULL;

CREATE TABLE processed_event (
    event_id     UUID PRIMARY KEY,
    consumer     VARCHAR(100) NOT NULL,
    processed_at TIMESTAMPTZ  NOT NULL
);
~~~

The partial index keeps the relay's "find unpublished" query fast even after millions of published rows. ^processed_event.event_id^ is the primary key: that unique constraint is our idempotency guard.

### Step 3: The event contract

~~~java src/main/java/com/example/taskflow/events/TaskAssignedEvent.java
package com.example.taskflow.events;

import java.time.Instant;
import java.util.UUID;

/**
 * Integration event: a task was assigned to a user.
 * This record is the public contract; treat changes like an API change.
 */
public record TaskAssignedEvent(
        UUID eventId,
        Long taskId,
        String taskTitle,
        Long projectId,
        Long assigneeId,
        String assigneeEmail,
        Long assignedById,
        Instant occurredAt) {

    public static final String TYPE = "TaskAssigned";
}
~~~

### Step 4: The outbox entity and repository

~~~java src/main/java/com/example/taskflow/outbox/OutboxEvent.java
package com.example.taskflow.outbox;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "outbox_event")
public class OutboxEvent {

    @Id
    private UUID id;

    @Column(name = "aggregate_type", nullable = false)
    private String aggregateType;

    @Column(name = "aggregate_id", nullable = false)
    private String aggregateId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "published_at")
    private Instant publishedAt;

    protected OutboxEvent() {
    }

    public OutboxEvent(UUID id, String aggregateType, String aggregateId,
                       String eventType, String payload, Instant createdAt) {
        this.id = id;
        this.aggregateType = aggregateType;
        this.aggregateId = aggregateId;
        this.eventType = eventType;
        this.payload = payload;
        this.createdAt = createdAt;
    }

    public void markPublished(Instant when) {
        this.publishedAt = when;
    }

    public UUID getId() { return id; }
    public String getAggregateType() { return aggregateType; }
    public String getAggregateId() { return aggregateId; }
    public String getEventType() { return eventType; }
    public String getPayload() { return payload; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getPublishedAt() { return publishedAt; }
}
~~~

~~~java src/main/java/com/example/taskflow/outbox/OutboxRepository.java
package com.example.taskflow.outbox;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.QueryHints;
import jakarta.persistence.LockModeType;
import jakarta.persistence.QueryHint;
import org.springframework.data.domain.Limit;

import java.util.List;
import java.util.UUID;

public interface OutboxRepository extends JpaRepository<OutboxEvent, UUID> {

    /**
     * Locks a batch of unpublished rows. SKIP LOCKED (timeout -2 in Hibernate)
     * lets several app instances run the relay without publishing the same row twice.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @QueryHints(@QueryHint(name = "jakarta.persistence.lock.timeout", value = "-2"))
    @Query("select o from OutboxEvent o where o.publishedAt is null order by o.createdAt")
    List<OutboxEvent> findUnpublished(Limit limit);
}
~~~

The lock timeout hint value ^-2^ is Hibernate's signal for ^SKIP LOCKED^ on PostgreSQL. Two TaskFlow instances can both run the relay: each grabs different rows.

### Step 5: Writing to the outbox inside the business transaction

First, the change to ^TaskService^. It publishes an in-process Spring event; it knows nothing about outboxes or brokers.

~~~java src/main/java/com/example/taskflow/service/TaskService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.TaskResponse;
import com.example.taskflow.events.TaskAssignedEvent;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.User;
import com.example.taskflow.repository.TaskRepository;
import com.example.taskflow.repository.UserRepository;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

@Service
public class TaskService {

    private final TaskRepository taskRepository;
    private final UserRepository userRepository;
    private final ApplicationEventPublisher events;
    private final Clock clock;

    public TaskService(TaskRepository taskRepository, UserRepository userRepository,
                       ApplicationEventPublisher events, Clock clock) {
        this.taskRepository = taskRepository;
        this.userRepository = userRepository;
        this.events = events;
        this.clock = clock;
    }

    // ... existing create/find/update methods from lessons 7.1-7.3 unchanged ...

    @Transactional
    public TaskResponse assign(Long taskId, Long assigneeId, Long currentUserId) {
        Task task = taskRepository.findById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
        User assignee = userRepository.findById(assigneeId)
                .orElseThrow(() -> new ResourceNotFoundException("User", assigneeId));

        task.setAssignee(assignee);

        events.publishEvent(new TaskAssignedEvent(
                UUID.randomUUID(),
                task.getId(),
                task.getTitle(),
                task.getProject().getId(),
                assignee.getId(),
                assignee.getEmail(),
                currentUserId,
                Instant.now(clock)));

        return TaskResponse.from(task);
    }
}
~~~

Now the listener that turns the in-process event into an outbox row. Note the phase: **BEFORE_COMMIT**. It runs inside the still-open transaction, so the outbox insert and the task update commit or roll back together. That is the whole trick.

~~~java src/main/java/com/example/taskflow/outbox/OutboxWriter.java
package com.example.taskflow.outbox;

import com.example.taskflow.events.TaskAssignedEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;

@Component
public class OutboxWriter {

    private final OutboxRepository outbox;
    private final ObjectMapper objectMapper;

    public OutboxWriter(OutboxRepository outbox, ObjectMapper objectMapper) {
        this.outbox = outbox;
        this.objectMapper = objectMapper;
    }

    @TransactionalEventListener(phase = TransactionPhase.BEFORE_COMMIT)
    public void on(TaskAssignedEvent event) {
        outbox.save(new OutboxEvent(
                event.eventId(),
                "Task",
                String.valueOf(event.taskId()),
                TaskAssignedEvent.TYPE,
                toJson(event),
                event.occurredAt()));
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Cannot serialize event", e);
        }
    }
}
~~~

> **Under the hood:** ^@TransactionalEventListener^ does not run when ^publishEvent^ is called. Spring registers a ^TransactionSynchronization^ on the current transaction; when the transaction manager reaches ^beforeCommit^, it calls our method. If no transaction is active, the event is silently dropped (unless you set ^fallbackExecution = true^), which is why ^assign^ must be ^@Transactional^.

### Step 6: The broker abstraction and the relay

~~~java src/main/java/com/example/taskflow/outbox/EventPublisher.java
package com.example.taskflow.outbox;

/** Publishes an outbox row to a broker. Must throw if the broker did not confirm. */
public interface EventPublisher {
    void publish(OutboxEvent event) throws Exception;
}
~~~

~~~java src/main/java/com/example/taskflow/outbox/OutboxRelay.java
package com.example.taskflow.outbox;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.List;

@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);

    private final OutboxRepository outbox;
    private final EventPublisher publisher;
    private final Clock clock;

    public OutboxRelay(OutboxRepository outbox, EventPublisher publisher, Clock clock) {
        this.outbox = outbox;
        this.publisher = publisher;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "PT1S")
    @Transactional
    public void relay() {
        List<OutboxEvent> batch = outbox.findUnpublished(Limit.of(100));
        for (OutboxEvent event : batch) {
            try {
                publisher.publish(event);
                event.markPublished(Instant.now(clock));
            } catch (Exception e) {
                // Stop at first failure to preserve order; retry on the next tick.
                log.warn("Outbox publish failed for {}: {}", event.getId(), e.getMessage());
                break;
            }
        }
    }
}
~~~

Enable scheduling and provide a ^Clock^ bean (if lesson 7.x did not already):

~~~java src/main/java/com/example/taskflow/TaskflowApplication.java
package com.example.taskflow;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;

import java.time.Clock;

@SpringBootApplication
@EnableScheduling
public class TaskflowApplication {

    public static void main(String[] args) {
        SpringApplication.run(TaskflowApplication.class, args);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
~~~

### Step 7: RabbitMQ topology, publisher and JSON conversion

We declare a durable topic exchange ^taskflow.events^, a queue ^notification.task-assigned^ bound with routing key ^task.assigned^, and a dead-letter exchange plus queue. Spring AMQP's ^RabbitAdmin^ (auto-configured) finds ^Declarable^ beans at startup and declares them on the broker idempotently.

~~~java src/main/java/com/example/taskflow/messaging/rabbit/RabbitConfig.java
package com.example.taskflow.messaging.rabbit;

import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.DirectExchange;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import com.fasterxml.jackson.databind.ObjectMapper;

@Configuration
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "rabbit", matchIfMissing = true)
public class RabbitConfig {

    public static final String EVENTS_EXCHANGE = "taskflow.events";
    public static final String DLX = "taskflow.dlx";
    public static final String TASK_ASSIGNED_KEY = "task.assigned";
    public static final String NOTIFICATION_QUEUE = "notification.task-assigned";
    public static final String NOTIFICATION_DLQ = "notification.task-assigned.dlq";

    @Bean
    TopicExchange eventsExchange() {
        return new TopicExchange(EVENTS_EXCHANGE, true, false);
    }

    @Bean
    DirectExchange deadLetterExchange() {
        return new DirectExchange(DLX, true, false);
    }

    @Bean
    Queue notificationQueue() {
        return QueueBuilder.durable(NOTIFICATION_QUEUE)
                .deadLetterExchange(DLX)
                .deadLetterRoutingKey(NOTIFICATION_DLQ)
                .quorum()
                .build();
    }

    @Bean
    Queue notificationDlq() {
        return QueueBuilder.durable(NOTIFICATION_DLQ).quorum().build();
    }

    @Bean
    Binding notificationBinding() {
        return BindingBuilder.bind(notificationQueue()).to(eventsExchange()).with(TASK_ASSIGNED_KEY);
    }

    @Bean
    Binding dlqBinding() {
        return BindingBuilder.bind(notificationDlq()).to(deadLetterExchange()).with(NOTIFICATION_DLQ);
    }

    /** Boot's auto-configured RabbitTemplate and listener factory pick this bean up. */
    @Bean
    MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }
}
~~~

When you define a ^MessageConverter^ bean, Spring Boot's ^RabbitAutoConfiguration^ wires it into both the ^RabbitTemplate^ and the ^@RabbitListener^ container factory. Without it, Spring AMQP falls back to Java serialization, which is insecure and not language-neutral.

The publisher sends the already-serialized JSON payload and waits for a **publisher confirm**, the broker's acknowledgment that it durably accepted the message. Without confirms, "send succeeded" only means "bytes left the socket".

~~~java src/main/java/com/example/taskflow/messaging/rabbit/RabbitEventPublisher.java
package com.example.taskflow.messaging.rabbit;

import com.example.taskflow.outbox.EventPublisher;
import com.example.taskflow.outbox.OutboxEvent;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.MessageBuilder;
import org.springframework.amqp.core.MessageDeliveryMode;
import org.springframework.amqp.core.MessageProperties;
import org.springframework.amqp.rabbit.connection.CorrelationData;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

@Component
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "rabbit", matchIfMissing = true)
public class RabbitEventPublisher implements EventPublisher {

    private final RabbitTemplate rabbitTemplate;

    public RabbitEventPublisher(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }

    @Override
    public void publish(OutboxEvent event) throws Exception {
        Message message = MessageBuilder
                .withBody(event.getPayload().getBytes(StandardCharsets.UTF_8))
                .setContentType(MessageProperties.CONTENT_TYPE_JSON)
                .setMessageId(event.getId().toString())
                .setDeliveryMode(MessageDeliveryMode.PERSISTENT)
                .setHeader("__TypeId__", "com.example.taskflow.events.TaskAssignedEvent")
                .setHeader("eventType", event.getEventType())
                .build();

        CorrelationData correlation = new CorrelationData(event.getId().toString());
        rabbitTemplate.send(RabbitConfig.EVENTS_EXCHANGE, RabbitConfig.TASK_ASSIGNED_KEY, message, correlation);

        CorrelationData.Confirm confirm = correlation.getFuture().get(5, TimeUnit.SECONDS);
        if (!confirm.isAck()) {
            throw new IllegalStateException("Broker nacked message: " + confirm.getReason());
        }
    }
}
~~~

The ^__TypeId__^ header tells ^Jackson2JsonMessageConverter^ on the consumer side which class to deserialize into. In a real multi-service setup you would map logical type names instead of class names, but here producer and consumer share the record.

For ad-hoc messages that are not outbox rows, ^rabbitTemplate.convertAndSend(exchange, routingKey, someRecord)^ uses the JSON converter directly.

### Step 8: The idempotent notification consumer

~~~java src/main/java/com/example/taskflow/notification/ProcessedEvent.java
package com.example.taskflow.notification;

import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Column;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "processed_event")
public class ProcessedEvent {

    @Id
    @Column(name = "event_id")
    private UUID eventId;

    @Column(nullable = false)
    private String consumer;

    @Column(name = "processed_at", nullable = false)
    private Instant processedAt;

    protected ProcessedEvent() {
    }

    public ProcessedEvent(UUID eventId, String consumer, Instant processedAt) {
        this.eventId = eventId;
        this.consumer = consumer;
        this.processedAt = processedAt;
    }

    public UUID getEventId() { return eventId; }
}
~~~

~~~java src/main/java/com/example/taskflow/notification/ProcessedEventRepository.java
package com.example.taskflow.notification;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.UUID;

public interface ProcessedEventRepository extends JpaRepository<ProcessedEvent, UUID> {
}
~~~

~~~java src/main/java/com/example/taskflow/notification/NotificationService.java
package com.example.taskflow.notification;

import com.example.taskflow.events.TaskAssignedEvent;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;

@Service
public class NotificationService {

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);
    private static final String CONSUMER = "notification";

    private final ProcessedEventRepository processed;
    private final Clock clock;

    public NotificationService(ProcessedEventRepository processed, Clock clock) {
        this.processed = processed;
        this.clock = clock;
    }

    /**
     * Idempotent: a duplicate delivery of the same eventId is detected and skipped.
     * Returns true if the event was handled now, false if it was a duplicate.
     */
    @Transactional
    public boolean handle(TaskAssignedEvent event) {
        if (processed.existsById(event.eventId())) {
            log.info("Duplicate event {} ignored", event.eventId());
            return false;
        }
        if (event.assigneeEmail() == null || event.assigneeEmail().isBlank()) {
            // A permanent problem: retrying will never help.
            throw new IllegalArgumentException("Event " + event.eventId() + " has no assignee email");
        }
        // In production: send email / push notification. Here we log.
        log.info("NOTIFY {}: you were assigned task #{} '{}'",
                event.assigneeEmail(), event.taskId(), event.taskTitle());

        // saveAndFlush forces the INSERT now; a concurrent duplicate fails on the primary key
        processed.saveAndFlush(new ProcessedEvent(event.eventId(), CONSUMER, Instant.now(clock)));
        return true;
    }
}
~~~

The ^existsById^ check handles the common duplicate; the primary key handles the race where two consumers get the same message at once. Whoever loses gets a constraint violation, the transaction rolls back, and the redelivery sees the row and skips.

> Be honest about a subtle point: sending an email is not transactional. If the mail is sent and then the insert fails, the next delivery sends again. Truly external side effects are at-least-once; make them idempotent at the provider (many email/SMS APIs accept an idempotency key: pass the ^eventId^).

Now the Rabbit listener:

~~~java src/main/java/com/example/taskflow/messaging/rabbit/TaskAssignedRabbitListener.java
package com.example.taskflow.messaging.rabbit;

import com.example.taskflow.events.TaskAssignedEvent;
import com.example.taskflow.notification.NotificationService;
import org.springframework.amqp.rabbit.annotation.RabbitListener;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "rabbit", matchIfMissing = true)
public class TaskAssignedRabbitListener {

    private final NotificationService notifications;

    public TaskAssignedRabbitListener(NotificationService notifications) {
        this.notifications = notifications;
    }

    @RabbitListener(queues = RabbitConfig.NOTIFICATION_QUEUE)
    public void onTaskAssigned(TaskAssignedEvent event) {
        notifications.handle(event);
    }
}
~~~

**What Spring does here:** at startup, ^RabbitListenerAnnotationBeanPostProcessor^ finds the annotation and creates a ^SimpleMessageListenerContainer^ with consumer threads. For each delivery, the container converts the body using our JSON converter and the ^__TypeId__^ header, invokes the method, and, in the default AUTO ack mode, sends ack if the method returns normally or reject if it throws.

### Step 9: Retry and dead-lettering for RabbitMQ

If the listener throws, by default Spring AMQP rejects and **requeues**, so a poison message loops forever, burning CPU. We configure stateless retry with exponential backoff, then reject without requeue, which makes RabbitMQ route it to the dead-letter exchange we configured on the queue.

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: taskflow
  datasource:
    url: §{DB_URL:jdbc:postgresql://localhost:5432/taskflow}
    username: §{DB_USER:taskflow}
    password: §{DB_PASSWORD:taskflow}
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
  rabbitmq:
    host: §{RABBIT_HOST:localhost}
    port: 5672
    username: §{RABBIT_USER:taskflow}
    password: §{RABBIT_PASSWORD:taskflow}
    publisher-confirm-type: correlated
    publisher-returns: true
    listener:
      simple:
        acknowledge-mode: auto
        default-requeue-rejected: false
        prefetch: 20
        retry:
          enabled: true
          max-attempts: 4
          initial-interval: 1s
          multiplier: 2.0
          max-interval: 10s
  kafka:
    bootstrap-servers: §{KAFKA_BOOTSTRAP:localhost:9092}
    producer:
      acks: all
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
      value-serializer: org.apache.kafka.common.serialization.StringSerializer
      properties:
        enable.idempotence: true
    consumer:
      group-id: notification-service
      auto-offset-reset: earliest
      key-deserializer: org.apache.kafka.common.serialization.StringDeserializer
      value-deserializer: org.springframework.kafka.support.serializer.ErrorHandlingDeserializer
      properties:
        spring.deserializer.value.delegate.class: org.springframework.kafka.support.serializer.JsonDeserializer
        spring.json.trusted.packages: com.example.taskflow.events
        spring.json.value.default.type: com.example.taskflow.events.TaskAssignedEvent
        spring.json.use.type.headers: false
    listener:
      ack-mode: record

taskflow:
  messaging:
    broker: §{TASKFLOW_BROKER:rabbit}
  jwt:
    secret: §{JWT_SECRET:change-me-to-a-long-random-secret-at-least-32-bytes}

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
~~~

With ^default-requeue-rejected: false^, after the 4th failed attempt the retry interceptor's recoverer rejects without requeue and RabbitMQ dead-letters it to ^notification.task-assigned.dlq^, with an ^x-death^ header explaining why. Note that this in-memory retry blocks the consumer thread during backoff; for long delays use a TTL-based "retry queue" that dead-letters back into the main queue.

> **Watch out:** when Boot's Rabbit auto-configuration and Kafka auto-configuration both see their libraries, they both activate. That is fine: the Kafka beans connect lazily. If you want only one broker in a given environment, exclude the other's auto-configuration or simply keep only the dependency you use.

### Step 10: The Kafka side

Topic ^taskflow.task-events^ with 3 partitions, plus a ^.DLT^ topic. Spring Boot's ^KafkaAdmin^ creates any ^NewTopic^ beans at startup.

~~~java src/main/java/com/example/taskflow/messaging/kafka/KafkaConfig.java
package com.example.taskflow.messaging.kafka;

import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.common.TopicPartition;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.serializer.DeserializationException;
import org.springframework.util.backoff.ExponentialBackOff;

@Configuration
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "kafka")
public class KafkaConfig {

    public static final String TASK_EVENTS_TOPIC = "taskflow.task-events";
    public static final String TASK_EVENTS_DLT = "taskflow.task-events.DLT";

    @Bean
    NewTopic taskEventsTopic() {
        return TopicBuilder.name(TASK_EVENTS_TOPIC).partitions(3).replicas(1).build();
    }

    @Bean
    NewTopic taskEventsDlt() {
        return TopicBuilder.name(TASK_EVENTS_DLT).partitions(3).replicas(1).build();
    }

    /**
     * Boot detects a single CommonErrorHandler bean and installs it on the
     * auto-configured listener container factory.
     */
    @Bean
    DefaultErrorHandler kafkaErrorHandler(KafkaTemplate<Object, Object> template) {
        var recoverer = new DeadLetterPublishingRecoverer(template,
                (record, ex) -> new TopicPartition(TASK_EVENTS_DLT, record.partition()));

        var backOff = new ExponentialBackOff(1000L, 2.0);
        backOff.setMaxAttempts(3);

        var handler = new DefaultErrorHandler(recoverer, backOff);
        handler.addNotRetryableExceptions(IllegalArgumentException.class, DeserializationException.class);
        return handler;
    }
}
~~~

**How DefaultErrorHandler works:** when the listener throws, the handler re-seeks the consumer to the failed record so it is re-delivered on the next poll, after sleeping for the backoff interval. Once retries are exhausted (or immediately for not-retryable exceptions), the recoverer publishes the original record, with exception headers such as ^kafka_dlt-exception-message^, to the DLT and the offset is committed so the partition moves on. Since Kafka is a log, a stuck record blocks its whole partition: retries must be bounded.

The ^ErrorHandlingDeserializer^ in the YAML matters: if a malformed message arrives, a plain ^JsonDeserializer^ would throw inside ^poll()^ before your code ever runs, and the consumer would loop on it forever. The wrapper catches the failure and hands it to the error handler as a ^DeserializationException^, which we route straight to the DLT.

The publisher uses the **task id as the key**, so all events for one task land in the same partition, in order:

~~~java src/main/java/com/example/taskflow/messaging/kafka/KafkaEventPublisher.java
package com.example.taskflow.messaging.kafka;

import com.example.taskflow.outbox.EventPublisher;
import com.example.taskflow.outbox.OutboxEvent;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

@Component
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "kafka")
public class KafkaEventPublisher implements EventPublisher {

    private final KafkaTemplate<String, String> kafkaTemplate;

    public KafkaEventPublisher(KafkaTemplate<String, String> kafkaTemplate) {
        this.kafkaTemplate = kafkaTemplate;
    }

    @Override
    public void publish(OutboxEvent event) throws Exception {
        var record = new ProducerRecord<String, String>(
                KafkaConfig.TASK_EVENTS_TOPIC, event.getAggregateId(), event.getPayload());
        record.headers().add("eventType", event.getEventType().getBytes(StandardCharsets.UTF_8));
        record.headers().add("eventId", event.getId().toString().getBytes(StandardCharsets.UTF_8));

        // Block until the broker acknowledges (acks=all): the relay must know it succeeded.
        kafkaTemplate.send(record).get(10, TimeUnit.SECONDS);
    }
}
~~~

In Spring Kafka 3.x, ^send^ returns a ^CompletableFuture<SendResult>^ (the old ^ListenableFuture^ is gone). Because we serialize to a JSON string in the outbox, the producer uses ^StringSerializer^; the consumer deserializes the JSON into the record.

~~~java src/main/java/com/example/taskflow/messaging/kafka/TaskAssignedKafkaListener.java
package com.example.taskflow.messaging.kafka;

import com.example.taskflow.events.TaskAssignedEvent;
import com.example.taskflow.notification.NotificationService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "taskflow.messaging.broker", havingValue = "kafka")
public class TaskAssignedKafkaListener {

    private static final Logger log = LoggerFactory.getLogger(TaskAssignedKafkaListener.class);

    private final NotificationService notifications;

    public TaskAssignedKafkaListener(NotificationService notifications) {
        this.notifications = notifications;
    }

    @KafkaListener(topics = KafkaConfig.TASK_EVENTS_TOPIC, groupId = "notification-service", concurrency = "3")
    public void onTaskEvent(ConsumerRecord<String, TaskAssignedEvent> record) {
        log.debug("partition={} offset={} key={}", record.partition(), record.offset(), record.key());
        notifications.handle(record.value());
    }
}
~~~

^concurrency = "3"^ starts three consumer threads in one group, one per partition. A fourth would sit idle: **parallelism is capped by the partition count.** Choose partition counts with growth in mind; you can add partitions later but that remaps keys to partitions and breaks per-key ordering during the transition.

With ^ack-mode: record^ the container commits the offset after each record succeeds: at-least-once. If the app crashes between processing and committing, the record is redelivered and our idempotent consumer skips it.

### Step 11: Docker Compose with RabbitMQ and Kafka in KRaft mode

KRaft mode means Kafka manages its own metadata via the Raft protocol, so no ZooKeeper is needed (ZooKeeper support was removed in Kafka 4.0).

~~~yaml docker-compose.yml
services:
  postgres:
    image: postgres:16
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

  rabbitmq:
    image: rabbitmq:3.13-management
    environment:
      RABBITMQ_DEFAULT_USER: taskflow
      RABBITMQ_DEFAULT_PASS: taskflow
    ports:
      - "5672:5672"
      - "15672:15672"
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      retries: 10

  kafka:
    image: apache/kafka:3.8.0
    ports:
      - "9092:9092"
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:29092,EXTERNAL://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,EXTERNAL://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"

  app:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
      rabbitmq:
        condition: service_healthy
      kafka:
        condition: service_started
    environment:
      DB_URL: jdbc:postgresql://postgres:5432/taskflow
      DB_PASSWORD: §{DB_PASSWORD:-taskflow}
      RABBIT_HOST: rabbitmq
      KAFKA_BOOTSTRAP: kafka:29092
      TASKFLOW_BROKER: §{TASKFLOW_BROKER:-rabbit}
      JWT_SECRET: §{JWT_SECRET:-change-me-to-a-long-random-secret-at-least-32-bytes}
    ports:
      - "8080:8080"

volumes:
  pgdata:
~~~

Two listeners are the key detail: containers reach Kafka at ^kafka:29092^, your host at ^localhost:9092^. A broker returns its **advertised** address to clients; advertise the wrong one and clients connect, then mysteriously fail.

### Step 12: Run and test it

~~~powershell
docker compose up -d --build
# log in (from lesson 7.2) and capture the token
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body '{"email":"alice@example.com","password":"Secret123!"}').token
Invoke-RestMethod -Method Put -Uri http://localhost:8080/api/tasks/1/assignee -Headers @{Authorization="Bearer $token"} -ContentType "application/json" -Body '{"assigneeId":2}'
docker compose logs app --tail 20
~~~

Expected log lines (within about one second, the relay interval):

~~~text
INFO  c.e.t.notification.NotificationService : NOTIFY bob@example.com: you were assigned task #1 'Write onboarding docs'
~~~

Check the outbox:

~~~sql
SELECT event_type, aggregate_id, published_at FROM outbox_event ORDER BY created_at DESC LIMIT 1;
-- TaskAssigned | 1 | 2026-11-20 21:30:02.114+00
~~~

Open the RabbitMQ UI at http://localhost:15672 (taskflow/taskflow) to see the exchange, bindings and the DLQ. Switch to Kafka with ^TASKFLOW_BROKER=kafka^ in a ^.env^ file and ^docker compose up -d^ again.

### Step 13: Testing with Testcontainers

Spring Boot's ^@ServiceConnection^ reads the container's host and port and overrides ^spring.datasource.*^ and ^spring.rabbitmq.*^ automatically, so no ^@DynamicPropertySource^ is needed.

~~~java src/test/java/com/example/taskflow/messaging/TaskAssignedRabbitIT.java
package com.example.taskflow.messaging;

import com.example.taskflow.events.TaskAssignedEvent;
import com.example.taskflow.messaging.rabbit.RabbitConfig;
import com.example.taskflow.notification.ProcessedEventRepository;
import org.junit.jupiter.api.Test;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

@SpringBootTest(properties = "taskflow.messaging.broker=rabbit")
@Testcontainers
class TaskAssignedRabbitIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Container
    @ServiceConnection
    static RabbitMQContainer rabbit = new RabbitMQContainer("rabbitmq:3.13-management");

    @Autowired
    RabbitTemplate rabbitTemplate;

    @Autowired
    ProcessedEventRepository processed;

    @Test
    void duplicateDeliveryIsProcessedOnce() {
        var event = new TaskAssignedEvent(UUID.randomUUID(), 1L, "Test task", 1L,
                2L, "bob@example.com", 1L, Instant.now());

        rabbitTemplate.convertAndSend(RabbitConfig.EVENTS_EXCHANGE, RabbitConfig.TASK_ASSIGNED_KEY, event);
        rabbitTemplate.convertAndSend(RabbitConfig.EVENTS_EXCHANGE, RabbitConfig.TASK_ASSIGNED_KEY, event);

        await().atMost(Duration.ofSeconds(10))
                .untilAsserted(() -> assertThat(processed.existsById(event.eventId())).isTrue());
        assertThat(processed.count()).isEqualTo(1);
    }

    @Test
    void poisonMessageEndsUpInDlq() {
        var bad = new TaskAssignedEvent(UUID.randomUUID(), 1L, "x", 1L, 2L, "", 1L, Instant.now());
        rabbitTemplate.convertAndSend(RabbitConfig.EVENTS_EXCHANGE, RabbitConfig.TASK_ASSIGNED_KEY, bad);

        await().atMost(Duration.ofSeconds(30)).untilAsserted(() ->
                assertThat(rabbitTemplate.receiveAndConvert(RabbitConfig.NOTIFICATION_DLQ)).isNotNull());
    }
}
~~~

For Kafka, use ^org.testcontainers.kafka.KafkaContainer^ with image ^apache/kafka:3.8.0^ and ^@ServiceConnection^, set ^taskflow.messaging.broker=kafka^, and send a JSON string with ^KafkaTemplate<String, String>^. Run with ^./mvnw verify^ (Docker must be running).

### Step 14: Monitoring consumer lag

**Consumer lag** is the distance between the newest message and what a consumer has processed. It is the single most important health signal of an event-driven system: growing lag means consumers cannot keep up, and notifications arrive minutes late.

| Signal | Where to see it |
|---|---|
| RabbitMQ queue depth (ready + unacked) | Management UI, ^rabbitmq_queue_messages_ready^ in Prometheus plugin |
| RabbitMQ DLQ depth | Alert if it is ever above 0 |
| Kafka lag per partition | ^kafka-consumer-groups.sh --describe^, Kafka exporter, or ^kafka.consumer.fetch.manager.records.lag.max^ via Micrometer |
| Outbox backlog | Custom gauge: count of rows with published_at null |

Inspect Kafka lag manually:

~~~powershell
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:29092 --describe --group notification-service
~~~

~~~text
GROUP                 TOPIC                 PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
notification-service  taskflow.task-events  0          14              14              0
notification-service  taskflow.task-events  1          9               12              3
~~~

Spring Kafka registers Micrometer metrics for its clients automatically when Actuator is present, so ^/actuator/prometheus^ exposes consumer lag metrics. Add an outbox gauge too: if the relay is broken, the broker looks healthy but nothing flows. Alert on lag *trend*, not a single spike.

---

## 3. Common Pitfalls & Best Practices

- **Publishing to the broker inside a database transaction (dual write).** Fix: write to an outbox table in the same transaction and let a relay publish.
- **Assuming exactly-once delivery.** Fix: assume at-least-once, give every event a unique ^eventId^, and make consumers idempotent with a processed-events table guarded by a unique key.
- **Infinite redelivery of poison messages.** Fix: bounded retry with backoff, then a dead-letter queue/topic, mark permanent errors as not retryable, and alert on DLQ depth.
- **Using Java serialization or class-coupled payloads.** Fix: JSON with an explicit, versioned event contract; add fields compatibly and never rename or remove them without a migration plan.
- **Kafka messages without keys when order matters.** Fix: key by aggregate id (task id) so related events share a partition; remember ordering is only per partition.
- **More consumers than partitions, or too few partitions.** Fix: size partitions for future parallelism; extra consumers in a group sit idle.
- **Forgetting publisher confirms or acks=all.** Fix: enable ^publisher-confirm-type: correlated^ for RabbitMQ and ^acks=all^ with idempotent producers for Kafka; only mark outbox rows published after confirmation.
- **Not monitoring lag and the outbox backlog.** Fix: expose metrics, dashboard queue depth, consumer lag and unpublished outbox rows, and alert on growth.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.`,
exercises:[
{"title":"Exercise 1 (Guided): Publish TaskCompleted through the outbox","tasks":["Create a ^TaskCompletedEvent^ record (eventId, taskId, projectId, completedById, occurredAt) and publish it from a ^complete^ method in ^TaskService^.","Extend ^OutboxWriter^ so it writes TaskCompleted rows to the outbox in the BEFORE_COMMIT phase.","Bind a new RabbitMQ queue ^audit.task-events^ to the ^taskflow.events^ exchange with the pattern ^task.*^ and log every event it receives.","Verify with the RabbitMQ management UI that assignment events reach both queues, and that completion events reach only the audit queue.","Write a Testcontainers test proving that rolling back the transaction (throw after publishEvent) leaves no row in ^outbox_event^."]},
{"title":"Exercise 2 (Challenge): Delayed retries and Kafka replay","tasks":["Replace the in-memory Rabbit retry with a TTL-based retry queue (^x-message-ttl^ of 30 seconds) that dead-letters back into the main queue, and cap total attempts using the ^x-death^ count header.","Switch TaskFlow to Kafka and create a second consumer group ^search-indexer^ that logs events; reset its offsets to the earliest position with ^kafka-consumer-groups.sh^ and observe the full replay.","Read the Spring Kafka reference on non-blocking retries (^@RetryableTopic^) and explain in a short note how it differs from ^DefaultErrorHandler^ regarding partition blocking and ordering.","Add a Micrometer gauge ^taskflow.outbox.backlog^ reporting unpublished outbox rows and confirm it appears at ^/actuator/prometheus^."]},
{"title":"Exercise 3 (Thinking): Design review","tasks":["Describe exactly what happens, step by step, if the app crashes after the Kafka broker acknowledged the send but before the relay transaction commits. Which component protects correctness?","Compare the polling relay with Debezium change-data-capture: list latency, operational cost, and failure modes for each.","TaskFlow will soon have 50 million events per day and three new consumer teams that want history from day one. Argue for RabbitMQ or Kafka with at least four concrete reasons.","Identify one side effect in TaskFlow that cannot be made idempotent with a processed-events table and propose how to protect it."]}
]
};
