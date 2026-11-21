LESSONS['7.1']={
md:String.raw`# Lesson 7.1 - Capstone Part 1: Requirements, Architecture & Domain Model

> **Where we stand:** You have built and hardened the Bookstore API across Modules 2-6: REST controllers, DTOs and validation, ProblemDetail errors, JPA with PostgreSQL, relationships and transactions, JWT security, tests and Docker. That project was a guided walk. The capstone is a **new** project, **TaskFlow**, and this time you are the engineer. These three lessons are a reference blueprint: the design, the decisions and the key code. You type it, you run it, you extend it.

**New project:** ^taskflow^ (group ^com.example^, artifact ^taskflow^, base package ^com.example.taskflow^). Every file in this lesson is new.

---

## 1. Concept & Theory

### 1.1 Why a capstone, and how to use these lessons

A capstone exists to answer one question: "Can you build a real backend from a blank folder without someone holding your hand?" Reading code is not the same as producing it. So treat this lesson the way a senior engineer treats a design doc handed over by an architect:

- Read the requirements and the API contract first. Decide whether you agree.
- Build the skeleton yourself (pom, config, entities, migrations) and only peek at the reference code when you are stuck.
- Run everything. A design that has not booted against a real database is a wish, not a design.

**Analogy:** An architect gives a builder the blueprints, not the bricks. The blueprints say where the load-bearing walls are (the domain model, the migrations, the security boundaries). The builder still lays every brick, and is allowed to improve the plumbing.

### 1.2 Product requirements as user stories

TaskFlow is a small but realistic multi-user task manager, like a very lean Jira or Trello backend.

| ID | As a... | I want to... | So that... |
|---|---|---|---|
| US-1 | visitor | register with email and password | I can get an account |
| US-2 | registered user | log in and receive a JWT | I can call protected endpoints |
| US-3 | user | create, rename and delete my own projects | I can organise my work |
| US-4 | user | list only my projects, paged | I am not flooded with data |
| US-5 | user | add tasks to my project with title, priority and due date | I can plan work |
| US-6 | user | filter tasks by status, priority and assignee and sort them | I find what matters now |
| US-7 | user | move a task through TODO, IN_PROGRESS, DONE | progress is visible |
| US-8 | user | be told when someone else changed a task I am editing | I never silently overwrite their work |
| US-9 | admin | see all users, projects and tasks | I can support and moderate |
| US-10 | operator | check health and read API docs | I can deploy and integrate safely |

**Non-functional requirements** (these are what make it "production-ready"):

| Area | Requirement |
|---|---|
| Security | Stateless JWT, BCrypt passwords, role-based access, ownership enforced on the server |
| Data | PostgreSQL, schema versioned with Flyway, no ^ddl-auto=update^ in prod |
| Consistency | Optimistic locking on Task; concurrent update returns 409 Conflict |
| Errors | RFC 9457 ProblemDetail for every error response |
| Observability | Actuator health, request-id on every log line and response header |
| Docs | OpenAPI 3 spec and Swagger UI generated from the code |
| Delivery | Tests (unit, slice, Testcontainers), multi-stage Docker image, CI pipeline |

### 1.3 The REST API contract

Agreeing the contract before writing code is called **API-first** (or contract-first) design. Frontend and backend teams can work in parallel, and reviewers can spot design mistakes (wrong verbs, leaky IDs) when they are cheap to fix.

| Method | Path | Purpose | Success | Typical errors | Role |
|---|---|---|---|---|---|
| POST | /api/auth/register | Create account | 201 | 400, 409 email taken | public |
| POST | /api/auth/login | Get JWT | 200 | 400, 401 | public |
| GET | /api/projects | List my projects (admin: all), paged | 200 | 401 | USER, ADMIN |
| POST | /api/projects | Create project | 201 + Location | 400, 401 | USER, ADMIN |
| GET | /api/projects/{id} | Get project | 200 | 401, 403, 404 | owner or ADMIN |
| PUT | /api/projects/{id} | Update project | 200 | 400, 401, 403, 404 | owner or ADMIN |
| DELETE | /api/projects/{id} | Delete project and its tasks | 204 | 401, 403, 404 | owner or ADMIN |
| GET | /api/projects/{id}/tasks | List tasks, filter status/priority/assigneeId, sort, page | 200 | 401, 403, 404 | owner or ADMIN |
| POST | /api/projects/{id}/tasks | Create task | 201 + Location | 400, 401, 403, 404 | owner or ADMIN |
| GET | /api/tasks/{id} | Get task | 200 | 401, 403, 404 | project owner, assignee or ADMIN |
| PUT | /api/tasks/{id} | Full update (requires version) | 200 | 400, 403, 404, 409 | project owner or ADMIN |
| PATCH | /api/tasks/{id}/status | Change status only | 200 | 400, 403, 404, 409 | project owner, assignee or ADMIN |
| DELETE | /api/tasks/{id} | Delete task | 204 | 401, 403, 404 | project owner or ADMIN |
| GET | /api/admin/users | List users | 200 | 401, 403 | ADMIN |
| GET | /actuator/health | Liveness/readiness | 200 | 503 | public |
| GET | /swagger-ui.html | API docs | 200 | - | public (dev), restricted (prod) |

Design notes a reviewer would expect you to defend:

- **Tasks are created under a project** (^POST /api/projects/{id}/tasks^) because a task cannot exist without one; but they are addressed directly afterwards (^/api/tasks/{id}^) to avoid deeply nested URLs.
- **403 vs 404:** for a resource that exists but belongs to someone else, many production APIs return 404 to avoid revealing that the ID exists. We return 403 for clarity while learning; Exercise 3 asks you to weigh the trade-off.
- **PUT requires the version** the client last saw. That is how optimistic locking reaches the HTTP layer.
- **Status changes get their own PATCH** because it is the most frequent operation and the assignee is allowed to do it while not being allowed to rewrite the whole task.

### 1.4 Architecture: layered inside, package-by-feature outside

In the Bookstore we used **package-by-layer** (controller, service, repository...). That is fine for small apps, but as an app grows, a single feature change touches five far-apart folders. **Package-by-feature** groups everything about one business capability together, and keeps the layers *inside* each feature.

~~~text
com.example.taskflow
 |-- TaskflowApplication.java
 |-- common/            (shared: exceptions, ProblemDetail handler, request-id filter, base config)
 |-- security/          (SecurityConfig, JwtService, JwtAuthFilter, CurrentUser helpers)
 |-- user/              (User entity, Role enum, UserRepository, AuthController, AuthService, DTOs)
 |-- project/           (Project entity, ProjectRepository, ProjectService, ProjectController, DTOs, mapper)
 |-- task/              (Task entity, enums, TaskRepository, TaskSpecifications, TaskService, TaskController, DTOs, mapper)

Request flow inside one feature:

  HTTP --> [RequestIdFilter] --> [JwtAuthFilter] --> [Controller] --> [Service @Transactional] --> [Repository] --> PostgreSQL
               |                     |                   |                   |
           MDC requestId       SecurityContext      DTO <-> mapper     ownership + business rules
                                                        |
                                          GlobalExceptionHandler --> ProblemDetail JSON
~~~

Rules of the architecture (write them on a sticky note):

| Rule | Why |
|---|---|
| Controllers never touch repositories | business rules and transactions live in one place: the service |
| Entities never leave the service layer | prevents lazy-loading surprises and accidental exposure of ^passwordHash^ |
| Features may depend on ^common^ and ^security^, never on each other's internals | task may use ^ProjectRepository^ through a service, but not the project controller |
| The schema belongs to Flyway | Hibernate validates, it does not create |

**Under the hood:** package structure matters to Spring too. ^@SpringBootApplication^ triggers component scanning from its own package downward, and Spring Data scans for repositories and ^@Entity^ classes the same way. Keep ^TaskflowApplication^ in ^com.example.taskflow^ and every feature folder is picked up automatically.

### 1.5 Domain model and ER diagram

~~~text
 +------------------+         +---------------------+          +-----------------------------+
 | users            |         | projects            |          | tasks                       |
 +------------------+         +---------------------+          +-----------------------------+
 | id         PK    |1      * | id          PK      |1       *  | id           PK             |
 | email   UNIQUE   |-------->| name                |---------->| title                       |
 | password_hash    |  owns   | description         | contains  | description                 |
 | role             |         | owner_id    FK      |           | status   (TODO/IN_PROGRESS/ |
 | created_at       |         | created_at          |           |           DONE)             |
 +------------------+         | updated_at          |           | priority (LOW/MEDIUM/HIGH/  |
        |1                    +---------------------+           |           URGENT)           |
        |                                                       | due_date                    |
        |              assigned to (optional)                 * | project_id   FK  NOT NULL   |
        +------------------------------------------------------>| assignee_id  FK  NULL       |
                                                                | version      (optimistic)   |
                                                                | created_at, updated_at      |
                                                                +-----------------------------+
~~~

Modelling decisions:

- **Unidirectional ^@ManyToOne^ only.** Project does not hold a ^List of Task^. Collections on the "one" side tempt people to load thousands of rows; queries with paging are almost always what you really want. Fewer bidirectional links means fewer infinite JSON loops and fewer N+1 traps.
- **All associations ^LAZY^.** ^@ManyToOne^ defaults to EAGER in JPA, which is a classic performance bug. We override it everywhere and fetch explicitly when needed.
- **Enums stored as strings** (^EnumType.STRING^). The default ^ORDINAL^ stores 0, 1, 2; insert a new value in the middle of the enum and every existing row silently changes meaning.
- **^version^ column** managed by Hibernate (^@Version^). Every update runs ^UPDATE ... SET version = 6 WHERE id = ? AND version = 5^. If zero rows match, someone else updated first, and Hibernate throws ^OptimisticLockException^.
- **Audit timestamps** via ^@CreationTimestamp^ and ^@UpdateTimestamp^, stored as ^timestamptz^ (^Instant^ in Java). Always store UTC.

### 1.6 Why Flyway replaces ddl-auto in production

In Module 3 you used ^spring.jpa.hibernate.ddl-auto=update^. It is wonderful for prototypes and dangerous in production:

| ddl-auto=update | Flyway migrations |
|---|---|
| Hibernate guesses the DDL from entities at startup | You write exact, reviewed SQL |
| Never drops or renames columns: renames become "new empty column" | Renames, data moves, backfills are explicit |
| No history: you cannot tell what ran on which environment | ^flyway_schema_history^ table records every script, checksum and timestamp |
| Different environments drift silently | Same scripts, same order, everywhere |
| Cannot be code-reviewed | Migrations live in Git and go through pull requests |
| Each app instance races to alter tables on startup | Flyway takes a database lock; only one instance migrates |

**How Flyway works under the hood:** at startup Spring Boot's ^FlywayAutoConfiguration^ sees ^flyway-core^ on the classpath and a ^DataSource^ bean. It creates a ^Flyway^ bean and a ^FlywayMigrationInitializer^ that runs **before** the ^EntityManagerFactory^ is built (Boot wires that dependency on purpose). Flyway scans ^classpath:db/migration^ for files named ^V{version}__{description}.sql^, compares them with the ^flyway_schema_history^ table, applies pending ones in order inside transactions, and stores a checksum of each. If someone edits an already-applied script, the checksum mismatches and startup fails, which is exactly what you want. Then Hibernate starts with ^ddl-auto=validate^ and checks that entities and tables agree, failing fast if they do not.

Since Flyway 10, database support is modular: ^flyway-core^ plus ^flyway-database-postgresql^. Forget the second one and you get "Unsupported Database: PostgreSQL" at startup.

> **Golden rule:** never edit a migration that has run anywhere shared. Add V2, V3... instead.

### 1.7 Profiles and configuration

| Profile | Database | Flyway | SQL logging | Swagger | Secrets |
|---|---|---|---|---|---|
| dev (default) | local Postgres from docker compose | on | on | on | safe defaults in yml |
| prod | managed Postgres from env vars | on | off | off | env vars only, no defaults |
| test | Testcontainers Postgres | on | off | on | test values |

Placeholders like ^§{DB_URL}^ are resolved by Spring's ^Environment^, which looks through property sources in precedence order: command-line args, OS environment variables, profile-specific yml, then the base yml. Relaxed binding means an env var ^JWT_SECRET^ fills ^§{JWT_SECRET}^, and ^SPRING_PROFILES_ACTIVE=prod^ activates the prod profile. In prod we deliberately give **no default** for secrets, so a missing secret crashes startup instead of running with a known password.

---

## 2. Code Walkthrough

### Step 1 - Generate the project

Use start.spring.io (or the IDE wizard): Maven, Java 21, Spring Boot 3.4.x, group ^com.example^, artifact ^taskflow^. Dependencies: Spring Web, Spring Data JPA, Validation, Spring Security, PostgreSQL Driver, Flyway Migration, Actuator, Lombok is **not** needed (we use records and plain getters), Testcontainers. Then align the pom with the one below.

~~~xml pom.xml
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

    <groupId>com.example</groupId>
    <artifactId>taskflow</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>taskflow</name>
    <description>TaskFlow - Task Management Backend API</description>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <!-- Web, persistence, validation, security, ops -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
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
            <artifactId>spring-boot-starter-actuator</artifactId>
        </dependency>

        <!-- Database + migrations -->
        <dependency>
            <groupId>org.postgresql</groupId>
            <artifactId>postgresql</artifactId>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-core</artifactId>
        </dependency>
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-database-postgresql</artifactId>
        </dependency>

        <!-- JWT -->
        <dependency>
            <groupId>io.jsonwebtoken</groupId>
            <artifactId>jjwt-api</artifactId>
            <version>0.12.6</version>
        </dependency>
        <dependency>
            <groupId>io.jsonwebtoken</groupId>
            <artifactId>jjwt-impl</artifactId>
            <version>0.12.6</version>
            <scope>runtime</scope>
        </dependency>
        <dependency>
            <groupId>io.jsonwebtoken</groupId>
            <artifactId>jjwt-jackson</artifactId>
            <version>0.12.6</version>
            <scope>runtime</scope>
        </dependency>

        <!-- OpenAPI / Swagger UI -->
        <dependency>
            <groupId>org.springdoc</groupId>
            <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
            <version>2.7.0</version>
        </dependency>

        <!-- Dev -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-devtools</artifactId>
            <scope>runtime</scope>
            <optional>true</optional>
        </dependency>

        <!-- Test -->
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-test</artifactId>
            <scope>test</scope>
        </dependency>
        <dependency>
            <groupId>org.springframework.security</groupId>
            <artifactId>spring-security-test</artifactId>
            <scope>test</scope>
        </dependency>
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

> Note: the JWT and springdoc versions are pinned explicitly because the Boot parent does not manage them. Flyway, PostgreSQL and Testcontainers versions are managed by the Boot parent, so you never pin them.

### Step 2 - Configuration with profiles

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: taskflow
  profiles:
    default: dev
  datasource:
    url: §{DB_URL:jdbc:postgresql://localhost:5432/taskflow}
    username: §{DB_USERNAME:taskflow}
    password: §{DB_PASSWORD:taskflow}
    hikari:
      maximum-pool-size: 10
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
    properties:
      hibernate:
        jdbc:
          time_zone: UTC
  flyway:
    enabled: true
    locations: classpath:db/migration

server:
  error:
    include-stacktrace: never
  shutdown: graceful

app:
  jwt:
    secret: §{JWT_SECRET:ZGV2LW9ubHktc2VjcmV0LWNoYW5nZS1tZS1pbi1wcm9kLTMyLWJ5dGVzLW1pbmltdW0=}
    expiration: §{JWT_EXPIRATION:PT1H}

management:
  endpoints:
    web:
      exposure:
        include: health,info
  endpoint:
    health:
      probes:
        enabled: true

springdoc:
  swagger-ui:
    path: /swagger-ui.html

---
spring:
  config:
    activate:
      on-profile: dev
  jpa:
    show-sql: true
    properties:
      hibernate:
        format_sql: true
logging:
  level:
    com.example.taskflow: DEBUG

---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    url: §{DB_URL}
    username: §{DB_USERNAME}
    password: §{DB_PASSWORD}
    hikari:
      maximum-pool-size: §{DB_POOL_SIZE:20}
app:
  jwt:
    secret: §{JWT_SECRET}
springdoc:
  api-docs:
    enabled: false
  swagger-ui:
    enabled: false
logging:
  level:
    root: INFO
~~~

Things to notice:

- ^open-in-view: false^. Boot enables Open Session In View by default, which keeps a DB connection for the entire HTTP request, including JSON rendering. That hides lazy-loading bugs and burns connections under load. Turning it off forces you to map entities to DTOs inside the transaction, which is good architecture anyway.
- ^ddl-auto: validate^ in every profile. Flyway owns the schema.
- The prod section has **no defaults** for DB and JWT secrets.
- ^server.shutdown: graceful^ lets in-flight requests finish when Kubernetes or Docker stops the container.

### Step 3 - The first migration

~~~sql src/main/resources/db/migration/V1__init.sql
-- V1: initial TaskFlow schema
CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    role          VARCHAR(20)  NOT NULL DEFAULT 'USER',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT uk_users_email UNIQUE (email),
    CONSTRAINT ck_users_role CHECK (role IN ('USER', 'ADMIN'))
);

CREATE TABLE projects (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(120)  NOT NULL,
    description VARCHAR(2000),
    owner_id    BIGINT        NOT NULL,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT fk_projects_owner FOREIGN KEY (owner_id) REFERENCES users (id)
);

CREATE INDEX idx_projects_owner ON projects (owner_id);

CREATE TABLE tasks (
    id          BIGSERIAL PRIMARY KEY,
    title       VARCHAR(200)  NOT NULL,
    description VARCHAR(4000),
    status      VARCHAR(20)   NOT NULL DEFAULT 'TODO',
    priority    VARCHAR(20)   NOT NULL DEFAULT 'MEDIUM',
    due_date    DATE,
    project_id  BIGINT        NOT NULL,
    assignee_id BIGINT,
    version     BIGINT        NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT fk_tasks_project  FOREIGN KEY (project_id)  REFERENCES projects (id) ON DELETE CASCADE,
    CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT ck_tasks_status   CHECK (status IN ('TODO', 'IN_PROGRESS', 'DONE')),
    CONSTRAINT ck_tasks_priority CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'URGENT'))
);

-- Indexes chosen from the query patterns in the API contract
CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);
CREATE INDEX idx_tasks_assignee       ON tasks (assignee_id);
CREATE INDEX idx_tasks_due_date       ON tasks (due_date);
~~~

Why these choices:

- **Named constraints** (^uk_users_email^) let the exception handler recognise a duplicate email from the DB error, and make prod incidents readable.
- **CHECK constraints** mirror the Java enums: the database defends itself even against a buggy script or a manual SQL fix.
- **^ON DELETE CASCADE^** for tasks of a deleted project is a business decision written in DDL; ^SET NULL^ for a deleted assignee keeps the task alive.
- **Indexes come from queries**, not from guesswork: "tasks of project X with status Y" is the hottest query, so a composite index on ^(project_id, status)^ serves it.
- PostgreSQL does **not** auto-index foreign keys. Forgetting ^idx_projects_owner^ makes "list my projects" a full table scan.

Do not seed an admin account through a migration with a hard-coded password hash. Migrations run in every environment, including production, and a copied hash is a backdoor. Instead, we seed a development admin from code, only under the ^dev^ profile, with the password encoded at runtime. **Important:** this class needs the ^PasswordEncoder^ bean that you create in Lesson 7.2. Save the file now if you like, but expect the app to fail to start under the ^dev^ profile until you have added that bean in 7.2 (or temporarily comment out the seeder).

~~~java src/main/java/com/example/taskflow/config/DevDataSeeder.java
package com.example.taskflow.config;

import com.example.taskflow.user.Role;
import com.example.taskflow.user.User;
import com.example.taskflow.user.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.security.crypto.password.PasswordEncoder;

@Configuration
@Profile("dev") // this bean does not exist in any other profile, so prod can never get a default admin
public class DevDataSeeder {

    private static final Logger log = LoggerFactory.getLogger(DevDataSeeder.class);

    @Bean
    CommandLineRunner seedAdmin(UserRepository users, PasswordEncoder encoder) {
        return args -> {
            String email = "admin@taskflow.dev";
            if (!users.existsByEmailIgnoreCase(email)) {
                users.save(new User(email, encoder.encode("admin123"), Role.ADMIN));
                log.info("Seeded development admin {}", email);
            }
        };
    }
}
~~~

In real production you would create the first admin through an ops script or a one-time secured bootstrap, never with a known password.

### Step 4 - The application class

~~~java src/main/java/com/example/taskflow/TaskflowApplication.java
package com.example.taskflow;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class TaskflowApplication {

    public static void main(String[] args) {
        SpringApplication.run(TaskflowApplication.class, args);
    }
}
~~~

^@EnableScheduling^ is there for the due-date reminder milestone you will build later.

### Step 5 - Enums

~~~java src/main/java/com/example/taskflow/user/Role.java
package com.example.taskflow.user;

public enum Role {
    USER,
    ADMIN
}
~~~

~~~java src/main/java/com/example/taskflow/task/TaskStatus.java
package com.example.taskflow.task;

public enum TaskStatus {
    TODO,
    IN_PROGRESS,
    DONE;

    /** Simple workflow rule: DONE tasks can be reopened only to TODO or IN_PROGRESS, any other move is allowed. */
    public boolean canTransitionTo(TaskStatus target) {
        return this != target;
    }
}
~~~

~~~java src/main/java/com/example/taskflow/task/TaskPriority.java
package com.example.taskflow.task;

public enum TaskPriority {
    LOW,
    MEDIUM,
    HIGH,
    URGENT
}
~~~

Putting a tiny rule like ^canTransitionTo^ on the enum is a first taste of a **rich domain model**: behaviour lives next to the data it governs, instead of scattered in if-statements across services.

### Step 6 - Entities

~~~java src/main/java/com/example/taskflow/user/User.java
package com.example.taskflow.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.Objects;

@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private Role role = Role.USER;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected User() {
        // required by JPA
    }

    public User(String email, String passwordHash, Role role) {
        this.email = email.toLowerCase();
        this.passwordHash = passwordHash;
        this.role = role;
    }

    public Long getId() { return id; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public Role getRole() { return role; }
    public Instant getCreatedAt() { return createdAt; }

    public boolean isAdmin() {
        return role == Role.ADMIN;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof User other)) return false;
        return id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return getClass().hashCode();
    }

    @Override
    public String toString() {
        return "User{id=" + id + ", email='" + email + "', role=" + role + "}";
    }
}
~~~

Why no setters for email or password, and why this ^equals^? Entities are identity objects: two ^User^ instances are the same if they have the same database ID. Before persisting, the ID is null, so we treat unsaved entities as never equal, and ^hashCode^ returns a constant so the hash does not change when the ID is assigned (a changing hash would lose the entity inside a ^HashSet^). ^toString^ deliberately excludes ^passwordHash^ so it never lands in a log.

~~~java src/main/java/com/example/taskflow/project/Project.java
package com.example.taskflow.project;

import com.example.taskflow.user.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "projects")
public class Project {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(length = 2000)
    private String description;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "owner_id", nullable = false)
    private User owner;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Project() {
    }

    public Project(String name, String description, User owner) {
        this.name = name;
        this.description = description;
        this.owner = owner;
    }

    public void rename(String name, String description) {
        this.name = name;
        this.description = description;
    }

    public boolean isOwnedBy(Long userId) {
        return owner.getId().equals(userId);
    }

    public Long getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public User getOwner() { return owner; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Project other)) return false;
        return id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return getClass().hashCode();
    }
}
~~~

**Magic under the hood:** ^owner.getId()^ in ^isOwnedBy^ does **not** trigger a SQL query even though ^owner^ is a lazy proxy. Hibernate proxies already know their identifier (it came from the ^owner_id^ column), so calling ^getId()^ returns it without initialising the proxy. Calling ^owner.getEmail()^ would hit the DB.

~~~java src/main/java/com/example/taskflow/task/Task.java
package com.example.taskflow.task;

import com.example.taskflow.project.Project;
import com.example.taskflow.user.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.time.LocalDate;

@Entity
@Table(name = "tasks")
public class Task {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(length = 4000)
    private String description;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TaskStatus status = TaskStatus.TODO;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TaskPriority priority = TaskPriority.MEDIUM;

    @Column(name = "due_date")
    private LocalDate dueDate;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "project_id", nullable = false)
    private Project project;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "assignee_id")
    private User assignee;

    @Version
    @Column(nullable = false)
    private Long version;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Task() {
    }

    public Task(String title, String description, TaskPriority priority, LocalDate dueDate,
                Project project, User assignee) {
        this.title = title;
        this.description = description;
        this.priority = priority != null ? priority : TaskPriority.MEDIUM;
        this.dueDate = dueDate;
        this.project = project;
        this.assignee = assignee;
    }

    public void update(String title, String description, TaskPriority priority,
                       LocalDate dueDate, User assignee) {
        this.title = title;
        this.description = description;
        this.priority = priority;
        this.dueDate = dueDate;
        this.assignee = assignee;
    }

    public void changeStatus(TaskStatus target) {
        if (!status.canTransitionTo(target)) {
            throw new IllegalStateException("Task is already " + target);
        }
        this.status = target;
    }

    public boolean isAssignedTo(Long userId) {
        return assignee != null && assignee.getId().equals(userId);
    }

    public Long getId() { return id; }
    public String getTitle() { return title; }
    public String getDescription() { return description; }
    public TaskStatus getStatus() { return status; }
    public TaskPriority getPriority() { return priority; }
    public LocalDate getDueDate() { return dueDate; }
    public Project getProject() { return project; }
    public User getAssignee() { return assignee; }
    public Long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Task other)) return false;
        return id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return getClass().hashCode();
    }
}
~~~

There is intentionally **no ^setVersion^**. Hibernate owns that field. In Lesson 7.2 the service compares the client's version with the entity's version itself; you never write it.

### Step 7 - Repositories

~~~java src/main/java/com/example/taskflow/user/UserRepository.java
package com.example.taskflow.user;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByEmailIgnoreCase(String email);

    boolean existsByEmailIgnoreCase(String email);
}
~~~

~~~java src/main/java/com/example/taskflow/project/ProjectRepository.java
package com.example.taskflow.project;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.Optional;

public interface ProjectRepository extends JpaRepository<Project, Long> {

    @EntityGraph(attributePaths = "owner")
    Page<Project> findByOwnerId(Long ownerId, Pageable pageable);

    @EntityGraph(attributePaths = "owner")
    @Query("select p from Project p")
    Page<Project> findAllWithOwner(Pageable pageable);

    @EntityGraph(attributePaths = "owner")
    Optional<Project> findWithOwnerById(Long id);

    boolean existsByIdAndOwnerId(Long id, Long ownerId);
}
~~~

~~~java src/main/java/com/example/taskflow/task/TaskRepository.java
package com.example.taskflow.task;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;

import java.util.Optional;

public interface TaskRepository extends JpaRepository<Task, Long>, JpaSpecificationExecutor<Task> {

    @Override
    @EntityGraph(attributePaths = {"project", "project.owner", "assignee"})
    Page<Task> findAll(Specification<Task> spec, Pageable pageable);

    @EntityGraph(attributePaths = {"project", "project.owner", "assignee"})
    Optional<Task> findWithDetailsById(Long id);
}
~~~

~~~java src/main/java/com/example/taskflow/task/TaskSpecifications.java
package com.example.taskflow.task;

import org.springframework.data.jpa.domain.Specification;

/** Composable WHERE-clause fragments for the task list filters. A null argument means "no filter". */
public final class TaskSpecifications {

    private TaskSpecifications() {
    }

    public static Specification<Task> inProject(Long projectId) {
        return (root, query, cb) -> cb.equal(root.get("project").get("id"), projectId);
    }

    public static Specification<Task> hasStatus(TaskStatus status) {
        return (root, query, cb) -> status == null ? null : cb.equal(root.get("status"), status);
    }

    public static Specification<Task> hasPriority(TaskPriority priority) {
        return (root, query, cb) -> priority == null ? null : cb.equal(root.get("priority"), priority);
    }

    public static Specification<Task> assignedTo(Long assigneeId) {
        return (root, query, cb) -> assigneeId == null ? null : cb.equal(root.get("assignee").get("id"), assigneeId);
    }
}
~~~

**Why Specifications?** With three optional filters you would need 2 x 2 x 2 = 8 derived query methods (^findByProjectIdAndStatusAndPriority...^). A Specification is a tiny predicate builder; returning ^null^ means "skip this condition", and Spring Data ANDs the rest together into one SQL query. The ^@EntityGraph^ tells Hibernate to join-fetch project, owner and assignee in the same query, so mapping a page of 20 tasks to DTOs costs **one** select plus a count, not 1 + 60.

**Under the hood:** at startup, Spring Data creates a JDK dynamic proxy for each repository interface backed by ^SimpleJpaRepository^. Derived names like ^findByEmailIgnoreCase^ are parsed once into a JPQL query (^where lower(u.email) = lower(?1)^); a typo in a property name fails at **startup**, not at runtime.

### Step 8 - Run it

~~~powershell
# Start a local Postgres (Lesson 7.3 gives you the full docker-compose file)
docker run -d --name taskflow-db -e POSTGRES_DB=taskflow -e POSTGRES_USER=taskflow -e POSTGRES_PASSWORD=taskflow -p 5432:5432 postgres:16-alpine

# Run the app with the dev profile (default)
./mvnw spring-boot:run
~~~

Expected log lines (abridged):

~~~text
Flyway Community Edition 10.x by Redgate
Database: jdbc:postgresql://localhost:5432/taskflow (PostgreSQL 16.x)
Successfully validated 1 migration
Creating Schema History table "public"."flyway_schema_history" ...
Migrating schema "public" to version "1 - init"
Successfully applied 1 migration to schema "public", now at version v1
HHH000204: Processing PersistenceUnitInfo ...
Tomcat started on port 8080 (http)
Started TaskflowApplication in 3.4 seconds
~~~

Check the history table:

~~~powershell
docker exec -it taskflow-db psql -U taskflow -d taskflow -c "select version, description, success from flyway_schema_history;"
~~~

~~~text
 version |  description | success
---------+--------------+---------
 1       | init         | t
~~~

Security is on the classpath but not configured yet, so every endpoint currently returns 401 with a generated password in the log. That is expected; Lesson 7.2 replaces it with JWT. To prove ^validate^ works, temporarily rename the ^title^ field's column to ^titel^ in ^Task^ and restart: startup fails with "Schema-validation: missing column [titel] in table [tasks]". Revert it.

---

## 3. Common Pitfalls & Best Practices

- **Leaving ddl-auto=update on with Flyway.** Two tools fighting over one schema produces drift. Fix: Flyway owns DDL, Hibernate uses ^validate^ everywhere.
- **Editing an applied migration.** Startup fails with a checksum mismatch on every other machine. Fix: never edit; add a new ^V3__...^ script. Locally only, you may use ^flyway repair^ or recreate the DB.
- **Forgetting flyway-database-postgresql.** Flyway 10+ reports an unsupported database. Fix: add the module dependency next to ^flyway-core^.
- **EAGER ^@ManyToOne^ by default.** Every task load drags project and owner along, and lists become N+1 storms. Fix: always declare ^FetchType.LAZY^ and fetch with ^@EntityGraph^ where needed.
- **ORDINAL enums.** Reordering the enum corrupts data silently. Fix: ^EnumType.STRING^ plus a DB CHECK constraint.
- **Lombok ^@Data^ on entities.** Generated ^equals/hashCode^ over all fields and ^toString^ touching lazy relations cause proxy initialisation and stack overflows. Fix: hand-written ID-based equality, minimal ^toString^.
- **Secrets with defaults in prod.** A forgotten env var silently runs with the dev secret. Fix: no default values in the prod profile; fail fast.
- **No indexes on foreign keys.** PostgreSQL does not create them. Fix: design indexes from the queries in your API contract, inside the migration.

---

## 4. Hands-On Practice

Complete the milestones below on your own. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Bootstrap TaskFlow from a blank folder","tasks":["Generate the ^taskflow^ project and reproduce the pom, ^application.yml^, the V1 migration, enums, entities and repositories without copy-pasting: type them and compare with the blueprint afterwards.","Acceptance: ^./mvnw spring-boot:run^ starts against local Postgres, logs \"now at version v1\" and ^flyway_schema_history^ shows one successful row.","Acceptance: changing a mapped column name in an entity makes startup fail with a schema-validation error, proving ^ddl-auto=validate^ works.","Start the app with ^SPRING_PROFILES_ACTIVE=prod^ and no ^JWT_SECRET^ set, and confirm it refuses to start. Write down the exact error message."]},
{"title":"Exercise 2 (Challenge): Milestone - design the Comment feature's data layer","tasks":["Requirement: users can comment on a task. A comment has id, body (max 2000 chars), author, task, createdAt. Deleting a task deletes its comments.","Write ^V3__comments.sql^ with table, named constraints and the indexes your future queries need (list comments of a task newest first).","Create a ^comment^ feature package with the ^Comment^ entity (LAZY associations, ID-based equality) and a ^CommentRepository^ with a paged query that fetches the author in the same SQL.","Acceptance: the app boots with migrations at v3, validate passes, and you can explain in two sentences why you did NOT add a ^List of Comment^ field to ^Task^.","Add an extra row to the API contract table in your own notes for ^GET/POST /api/tasks/{id}/comments^ with status codes and roles."]},
{"title":"Exercise 3 (Thinking): Defend the design","tasks":["Write a short paragraph: should a request for another user's project return 403 or 404? Consider security (ID enumeration), debuggability and what GitHub does for private repositories.","Plan the migration for soft delete of tasks (a ^deleted_at^ column): how will existing indexes and unique constraints need to change? Do not implement yet, just write the SQL you would add in V4.","Read the Flyway documentation section on baseline and explain how you would introduce Flyway to an existing production database that was created with ddl-auto.","List three queries you expect in the future (for example the due-date reminder) and decide which index each needs."]}
]
};
