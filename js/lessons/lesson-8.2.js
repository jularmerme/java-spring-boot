LESSONS['8.2']={
md:String.raw`## 1. Concept & Theory

In lesson 7.1 you added Flyway to TaskFlow and wrote one script, ^V1__init.sql^, that creates ^users^, ^projects^, ^project_members^ and ^tasks^. Flyway ran it on startup and Hibernate checked the result with ^ddl-auto: validate^. That is the happy path. Real systems live for years: the schema changes every sprint, several app instances run at once during a rolling deployment, tables grow to millions of rows, and somebody, someday, edits an applied migration by accident. This lesson turns you from "someone who uses Flyway" into someone who can change a production schema **without downtime and without fear**.

> **Where TaskFlow stands:** entities ^User^, ^Project^, ^Task^; ^V1__init.sql^; PostgreSQL in Docker Compose; Redis caching from 8.1. **This lesson adds** ^V2__create_comments.sql^, ^V3__add_soft_delete_to_tasks.sql^, a ^Comment^ entity, soft-delete for tasks, an expand/contract rename, a concurrent index, and a Testcontainers migration test.

### 1.1 Why migrations are code

Think of the database schema as the foundation of a building that people already live in. You cannot demolish and rebuild it on each release (that is what ^ddl-auto: create^ does). You need a **numbered, reviewed, repeatable list of construction steps** so that every environment, from Julian's laptop to production, ends up with exactly the same structure. Flyway gives you that list. Each migration is version-controlled, code-reviewed, tested in CI, and applied exactly once per database.

### 1.2 How Flyway works under the hood

On startup Spring Boot's ^FlywayAutoConfiguration^ creates a ^Flyway^ bean from the ^DataSource^ and a ^FlywayMigrationInitializer^ that calls ^migrate()^ **before** the ^EntityManagerFactory^ is built (Boot wires that dependency explicitly). Then:

1. Flyway acquires a lock (on PostgreSQL an advisory lock), so if three pods start together only one migrates; the others wait.
2. It reads or creates the history table ^flyway_schema_history^ with one row per applied migration: ^installed_rank^, ^version^, ^description^, ^type^, ^script^, ^checksum^, ^installed_by^, ^installed_on^, ^execution_time^, ^success^.
3. It scans ^classpath:db/migration^ for scripts, computes a CRC32 **checksum** of each, and compares with history.
4. It **validates**: every applied migration must still exist with the same checksum. Any mismatch stops startup.
5. It applies pending migrations in version order, each in its own transaction on PostgreSQL (which supports transactional DDL), and records the result.
6. Only then does Hibernate start and, with ^validate^, compare entities to the real tables.

### 1.3 Versioned vs repeatable migrations

| Type | Prefix | Runs | Use for |
|---|---|---|---|
| Versioned | ^V^ | Exactly once, in version order | Tables, columns, constraints, data fixes |
| Repeatable | ^R^ | Whenever its checksum changes, after all versioned | Views, functions, triggers, grants |
| Undo | ^U^ | Only via ^flyway undo^ (paid editions) | Rarely used; prefer forward fixes |

### 1.4 Naming

The pattern is ^V<version>__<description>.sql^ with **two** underscores. Version parts can be separated by dots or single underscores: ^V2__create_comments.sql^, ^V2.1__add_comment_index.sql^, ^V20261120_1405__add_priority.sql^. The description becomes the ^description^ column, with underscores turned into spaces. Repeatables have no version: ^R__task_overview_view.sql^.

Teams with many developers often use **timestamps** as versions. Two branches both creating ^V4^ is a merge conflict you discover only at deployment; ^V20261120_1405^ and ^V20261121_0910^ never collide. TaskFlow uses small integers for readability, which is fine for a small team that merges often.

### 1.5 Checksums: never edit an applied migration

When you change ^V1__init.sql^ after it ran anywhere, its checksum no longer matches history. On the next startup:

~~~text
FlywayValidateException: Validate failed: Migrations have failed validation
Migration checksum mismatch for migration version 1
-> Applied to database : 1287345511
-> Resolved locally    : -98234117
~~~

This is a feature. Your edit would not be executed on databases that already ran V1, so environments would silently diverge. The rule: **once a migration is merged and applied to a shared environment, it is immutable.** Fix mistakes with a new migration. The only acceptable edits are on your local database before pushing; then use ^flyway repair^ locally or just drop your local database.

### 1.6 validate, repair, baseline, out-of-order

| Command / property | What it does | When |
|---|---|---|
| ^validate^ | Compares scripts with history, fails on mismatch or missing scripts | Automatically before migrate; in CI |
| ^repair^ | Removes failed entries and realigns checksums to local files | After a failed migration on a non-transactional DB, or a deliberate cosmetic edit (comments only) |
| ^baseline^ | Marks an existing database as being at version N without running scripts up to N | Adopting Flyway on a database that already exists |
| ^spring.flyway.baseline-on-migrate^ | Auto-baseline if the schema is non-empty and has no history table | One-time adoption; turn off afterwards |
| ^spring.flyway.out-of-order^ | Allows applying a lower version after a higher one | Hotfix branches; use with care |
| ^clean^ | Drops everything | Never in production; Boot disables it by default (^clean-disabled: true^) |

**Baseline story:** say TaskFlow must be adopted by a company whose PostgreSQL schema was created by hand years ago. You dump the current schema into ^V1__baseline.sql^ (so new environments can build it), and on the existing production database you run with ^baseline-version: 1^ and ^baseline-on-migrate: true^ once. Flyway inserts a ^BASELINE^ row for V1 without executing it; from then on V2 and later apply normally.

**Out-of-order story:** production is at V7. A hotfix branch adds ^V6.1__fix_index.sql^. By default Flyway refuses to apply 6.1 because V7 is already applied (it reports it as ignored and validation fails). With ^out-of-order: true^ it applies it. It is safe only if 6.1 does not depend on or conflict with V7. Timestamp versions mostly avoid this situation.

### 1.7 Zero-downtime: the expand/contract pattern

During a rolling deployment, **old and new versions of the app run at the same time** against the same database for minutes. So each migration must be compatible with both the code before and the code after it. A "big bang" change like ^ALTER TABLE tasks RENAME COLUMN title TO name^ breaks every old pod instantly: their SQL still says ^title^.

The fix is **expand/contract** (parallel change), spread across several releases:

| Phase | Release | Database | Application |
|---|---|---|---|
| Expand | N | Add new column ^name^, nullable; backfill; trigger keeps both in sync | Old code writes ^title^ |
| Migrate code | N+1 | (nothing) | Reads and writes ^name^ |
| Contract | N+2 | Drop trigger, drop ^title^ | Only knows ^name^ |

Each step alone is backward-compatible. If release N+1 has a bug, you roll back the **code** to N and nothing breaks, because ^title^ is still there and kept in sync.

**Adding a NOT NULL column safely** follows the same idea:

1. Add the column as nullable (or with a constant default; since PostgreSQL 11, ^ADD COLUMN ... DEFAULT const NOT NULL^ is metadata-only and instant, but volatile defaults rewrite the table).
2. Deploy code that writes the column.
3. Backfill existing rows **in batches** so you do not hold long locks or create a huge transaction.
4. Add the constraint: on big tables first ^ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID^, then ^VALIDATE CONSTRAINT^ (which takes only a light lock), then ^SET NOT NULL^, which PostgreSQL 12+ performs without a full scan when a valid check constraint exists.

### 1.8 Locks, indexes and CONCURRENTLY

Many DDL statements take an ^ACCESS EXCLUSIVE^ lock. That lock waits behind any long-running query, and while it waits, **every new query on the table queues behind it**. A two-second ^ALTER^ can cause a two-minute outage. Always set ^lock_timeout^ in migrations so they fail fast instead of freezing the app, and retry later.

A plain ^CREATE INDEX^ blocks writes for the whole build. On a 50-million-row ^tasks^ table that is minutes of failed inserts. ^CREATE INDEX CONCURRENTLY^ builds without blocking writes, but **cannot run inside a transaction block**. Flyway wraps each migration in a transaction by default, so you get ^ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block^. Since Flyway 9 it detects some non-transactional statements automatically, but the explicit and reliable way is a script configuration file next to the migration: ^V5__index_tasks_due_date.sql.conf^ containing ^executeInTransaction=false^. Put only that one statement in the migration: if it fails halfway, there is no rollback, and PostgreSQL leaves an ^INVALID^ index you must drop before retrying (use ^IF NOT EXISTS^ carefully, since it would also accept the invalid leftover).

### 1.9 Seed data vs reference data

| Kind | Example | Where it belongs |
|---|---|---|
| Reference data | Task priorities, comment types, roles | Versioned migration, same in every environment |
| Seed / demo data | Demo user Julian, sample projects | Only dev and test: a separate location loaded by profile, or a test fixture |
| Production data fixes | Correcting a bad status on 300 rows | Versioned migration, reviewed, idempotent |

Configure ^spring.flyway.locations^ per profile: production uses ^classpath:db/migration^; dev adds ^classpath:db/dev-data^. Never put demo passwords into the shared migration folder.

### 1.10 Environments and ddl-auto

Flyway owns the schema; Hibernate only checks it. Use ^ddl-auto: validate^ in every environment, including tests, so a missing column fails at startup rather than at the first request. ^update^ is dangerous because it changes the schema behind Flyway's back, never drops or renames anything, and differs between environments. ^create-drop^ belongs only in throwaway prototypes.

### 1.11 Rollback strategy: forward-only

Down-migrations sound comforting but rarely work in practice: data written after the migration may not fit the old shape, and dropping a column loses data permanently. Mature teams follow **forward-only**:

- Make every migration backward-compatible (expand/contract), so a code rollback never needs a schema rollback.
- If a migration is wrong, write the next migration to fix it (^V8__fix_v7_default.sql^).
- Take a backup or snapshot before risky migrations; restoring is the true last resort.
- Keep destructive steps (drop column, drop table) in their own late "contract" release, after you are sure the data is no longer needed.

### 1.12 Flyway vs Liquibase

| Aspect | Flyway | Liquibase |
|---|---|---|
| Format | Plain SQL (also Java migrations) | XML, YAML, JSON or SQL changelogs |
| Mental model | Ordered versioned scripts | Changesets identified by id + author |
| Database portability | You write vendor SQL | Abstract change types generate SQL per DB |
| Rollback | Paid ^undo^ or forward-only | Built-in rollback blocks per changeset |
| Preconditions, contexts | Limited (placeholders, locations) | Rich preconditions, contexts and labels |
| Learning curve | Very low | Moderate |

Both are first-class in Spring Boot (^spring.liquibase.*^). Pick Flyway when your team is comfortable with SQL and targets one database; pick Liquibase when you must support several databases or need fine-grained preconditions. TaskFlow stays on Flyway.

## 2. Code Walkthrough

| File | Status |
|---|---|
| pom.xml | changed (flyway-database-postgresql) |
| application.yml, application-dev.yml | changed / new |
| db/migration/V2__create_comments.sql | new |
| db/migration/V3__add_soft_delete_to_tasks.sql | new |
| db/migration/V4__expand_task_title_to_name.sql | new |
| db/migration/V5__index_tasks_due_date.sql + .conf | new |
| db/migration/R__task_overview_view.sql | new |
| db/dev-data/V1000__demo_data.sql | new |
| model/Comment.java, model/Task.java | new / changed |
| repository/CommentRepository.java, TaskRepository.java | new / changed |
| service/CommentService.java, TaskService.java | new / changed |
| dto/CommentRequest.java, CommentResponse.java | new |
| controller/CommentController.java | new |
| test/.../FlywayMigrationIT.java | new |
| .github/workflows/ci.yml | changed |

### Step 1: Dependencies and configuration

Since Flyway 10, database support ships as separate modules. Without the PostgreSQL module you get ^Unsupported Database: PostgreSQL 16^.

~~~xml pom.xml (additions)
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-core</artifactId>
</dependency>
<dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-database-postgresql</artifactId>
</dependency>
~~~

~~~yaml src/main/resources/application.yml (flyway and jpa sections)
spring:
  jpa:
    hibernate:
      ddl-auto: validate
    open-in-view: false
  flyway:
    enabled: true
    locations: classpath:db/migration
    validate-on-migrate: true
    clean-disabled: true
    out-of-order: false
    baseline-on-migrate: false
    postgresql:
      transactional-lock: false
    placeholders:
      app_role: taskflow
~~~

^transactional-lock: false^ makes Flyway use a session-level advisory lock, which is required when some migrations run outside a transaction (our concurrent index). ^placeholders^ are referenced in SQL with the placeholder syntax, written in this course as ^§{app_role}^.

~~~yaml src/main/resources/application-dev.yml
spring:
  flyway:
    locations: classpath:db/migration,classpath:db/dev-data
~~~

### Step 2: V2, the comments table

~~~sql src/main/resources/db/migration/V2__create_comments.sql
SET lock_timeout = '5s';

CREATE TABLE comments (
    id          BIGSERIAL    PRIMARY KEY,
    task_id     BIGINT       NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    author_id   BIGINT       NOT NULL REFERENCES users (id),
    body        VARCHAR(4000) NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    version     BIGINT       NOT NULL DEFAULT 0,
    CONSTRAINT chk_comments_body_not_blank CHECK (length(trim(body)) > 0)
);

-- A new, empty table: a normal index is fine here (no rows, no traffic yet).
CREATE INDEX idx_comments_task_created ON comments (task_id, created_at);
CREATE INDEX idx_comments_author ON comments (author_id);

COMMENT ON TABLE comments IS 'User comments on tasks (TaskFlow V2)';
~~~

Creating a brand-new table is always backward-compatible: old code simply does not know it exists. Foreign keys need indexes on the referencing column, otherwise deleting a task scans the entire comments table.

### Step 3: V3, soft delete for tasks

~~~sql src/main/resources/db/migration/V3__add_soft_delete_to_tasks.sql
SET lock_timeout = '5s';

-- Nullable column without default: metadata-only change, instant even on huge tables.
ALTER TABLE tasks ADD COLUMN deleted_at TIMESTAMPTZ NULL;

-- Most queries ask for live tasks of one project. A partial index covers exactly that.
-- tasks is still small in TaskFlow; for big tables see V5 for the CONCURRENTLY approach.
CREATE INDEX idx_tasks_project_live ON tasks (project_id) WHERE deleted_at IS NULL;
~~~

Old pods keep working: they do not select ^deleted_at^, and new rows get NULL (= not deleted). New pods filter it. This is a perfect expand-only change.

### Step 4: The entities

~~~java src/main/java/com/example/taskflow/model/Comment.java
package com.example.taskflow.model;

import jakarta.persistence.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;

@Entity
@Table(name = "comments")
public class Comment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "task_id")
    private Task task;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "author_id")
    private User author;

    @Column(nullable = false, length = 4000)
    private String body;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected Comment() {
    }

    public Comment(Task task, User author, String body) {
        this.task = task;
        this.author = author;
        this.body = body;
    }

    public Long getId() { return id; }
    public Task getTask() { return task; }
    public User getAuthor() { return author; }
    public String getBody() { return body; }
    public void setBody(String body) { this.body = body; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
~~~

~~~java src/main/java/com/example/taskflow/model/Task.java
package com.example.taskflow.model;

import jakarta.persistence.*;
import org.hibernate.annotations.SQLRestriction;

import java.time.Instant;
import java.time.LocalDate;

@Entity
@Table(name = "tasks")
@SQLRestriction("deleted_at IS NULL")
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

    @Column(name = "due_date")
    private LocalDate dueDate;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "project_id")
    private Project project;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "assignee_id")
    private User assignee;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    @Version
    private long version;

    protected Task() {
    }

    public Task(String title, String description, LocalDate dueDate, Project project) {
        this.title = title;
        this.description = description;
        this.dueDate = dueDate;
        this.project = project;
    }

    public void softDelete(Instant now) {
        this.deletedAt = now;
    }

    public boolean isDeleted() { return deletedAt != null; }
    public Long getId() { return id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getDescription() { return description; }
    public TaskStatus getStatus() { return status; }
    public void setStatus(TaskStatus status) { this.status = status; }
    public LocalDate getDueDate() { return dueDate; }
    public Project getProject() { return project; }
    public User getAssignee() { return assignee; }
    public Instant getDeletedAt() { return deletedAt; }
}
~~~

^@SQLRestriction^ (Hibernate 6.3+, replacing the deprecated ^@Where^) appends ^deleted_at IS NULL^ to every query and collection load of ^Task^, so soft-deleted tasks disappear from the API automatically, including the aggregate queries from lesson 8.1. Your ^version^ column already existed in V1 from lesson 7.1; if it does not in your copy, add it in a migration rather than editing V1.

### Step 5: Soft delete in the service

~~~java src/main/java/com/example/taskflow/service/TaskService.java (changed method)
@Transactional
public void delete(Long taskId) {
    Task task = findTask(taskId);
    task.softDelete(Instant.now(clock));   // UPDATE instead of DELETE
    evictAfterCommit(task.getProject().getId());
}
~~~

Add ^Clock clock^ to the constructor. Because comments cascade only on a real ^DELETE^, soft-deleted tasks keep their comments, which is exactly what an "undo delete" or audit feature needs. A nightly job can hard-delete tasks soft-deleted more than 30 days ago.

### Step 6: Comment API

~~~java src/main/java/com/example/taskflow/dto/CommentRequest.java
package com.example.taskflow.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CommentRequest(@NotBlank @Size(max = 4000) String body) {
}
~~~

~~~java src/main/java/com/example/taskflow/dto/CommentResponse.java
package com.example.taskflow.dto;

import com.example.taskflow.model.Comment;

import java.time.Instant;

public record CommentResponse(Long id, Long taskId, Long authorId, String authorName,
                              String body, Instant createdAt) {
    public static CommentResponse from(Comment c) {
        return new CommentResponse(c.getId(), c.getTask().getId(), c.getAuthor().getId(),
                c.getAuthor().getDisplayName(), c.getBody(), c.getCreatedAt());
    }
}
~~~

~~~java src/main/java/com/example/taskflow/repository/CommentRepository.java
package com.example.taskflow.repository;

import com.example.taskflow.model.Comment;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CommentRepository extends JpaRepository<Comment, Long> {

    @EntityGraph(attributePaths = "author")
    Page<Comment> findByTaskIdOrderByCreatedAtAsc(Long taskId, Pageable pageable);
}
~~~

~~~java src/main/java/com/example/taskflow/service/CommentService.java
package com.example.taskflow.service;

import com.example.taskflow.dto.CommentRequest;
import com.example.taskflow.dto.CommentResponse;
import com.example.taskflow.exception.ResourceNotFoundException;
import com.example.taskflow.model.Comment;
import com.example.taskflow.model.Task;
import com.example.taskflow.model.User;
import com.example.taskflow.repository.CommentRepository;
import com.example.taskflow.repository.TaskRepository;
import com.example.taskflow.repository.UserRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class CommentService {

    private final CommentRepository commentRepository;
    private final TaskRepository taskRepository;
    private final UserRepository userRepository;

    public CommentService(CommentRepository commentRepository,
                          TaskRepository taskRepository,
                          UserRepository userRepository) {
        this.commentRepository = commentRepository;
        this.taskRepository = taskRepository;
        this.userRepository = userRepository;
    }

    @Transactional
    public CommentResponse add(Long taskId, String authorEmail, CommentRequest request) {
        Task task = taskRepository.findById(taskId)   // soft-deleted tasks are invisible: 404
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
        User author = userRepository.findByEmail(authorEmail)
                .orElseThrow(() -> new ResourceNotFoundException("User", authorEmail));
        Comment saved = commentRepository.save(new Comment(task, author, request.body().trim()));
        return CommentResponse.from(saved);
    }

    @Transactional(readOnly = true)
    public Page<CommentResponse> list(Long taskId, Pageable pageable) {
        if (!taskRepository.existsById(taskId)) {
            throw new ResourceNotFoundException("Task", taskId);
        }
        return commentRepository.findByTaskIdOrderByCreatedAtAsc(taskId, pageable)
                .map(CommentResponse::from);
    }
}
~~~

~~~java src/main/java/com/example/taskflow/controller/CommentController.java
package com.example.taskflow.controller;

import com.example.taskflow.dto.CommentRequest;
import com.example.taskflow.dto.CommentResponse;
import com.example.taskflow.service.CommentService;
import jakarta.validation.Valid;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

@RestController
@RequestMapping("/api/tasks/{taskId}/comments")
public class CommentController {

    private final CommentService commentService;

    public CommentController(CommentService commentService) {
        this.commentService = commentService;
    }

    @PostMapping
    public ResponseEntity<CommentResponse> add(@PathVariable Long taskId,
                                               @Valid @RequestBody CommentRequest request,
                                               @AuthenticationPrincipal Jwt jwt) {
        CommentResponse created = commentService.add(taskId, jwt.getSubject(), request);
        var location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }

    @GetMapping
    public Page<CommentResponse> list(@PathVariable Long taskId,
                                      @PageableDefault(size = 20) Pageable pageable) {
        return commentService.list(taskId, pageable);
    }
}
~~~

Run it:

~~~powershell
docker compose up -d postgres redis
./mvnw spring-boot:run
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/tasks/5/comments -Headers $h -ContentType "application/json" -Body '{"body":"Blocked by API review"}'
~~~

The log shows Flyway at work:

~~~text
Database: jdbc:postgresql://localhost:5432/taskflow (PostgreSQL 16.4)
Successfully validated 3 migrations (execution time 00:00.021s)
Current version of schema "public": 1
Migrating schema "public" to version "2 - create comments"
Migrating schema "public" to version "3 - add soft delete to tasks"
Successfully applied 2 migrations to schema "public", now at version v3
~~~

The POST returns ^201 Created^ with a ^Location^ header. Inspect history:

~~~sql
SELECT installed_rank, version, description, type, checksum, success
FROM flyway_schema_history ORDER BY installed_rank;
-- 1 | 1 | init                    | SQL | 1287345511 | t
-- 2 | 2 | create comments         | SQL | 551190032  | t
-- 3 | 3 | add soft delete to tasks| SQL | -40391877  | t
~~~

### Step 7: Expand/contract, renaming title to name

Product wants ^title^ renamed to ^name^ to match the mobile app. Release N, the **expand** migration:

~~~sql src/main/resources/db/migration/V4__expand_task_title_to_name.sql
SET lock_timeout = '5s';

ALTER TABLE tasks ADD COLUMN name VARCHAR(200);

-- Keep both columns in sync while old and new app versions run side by side.
CREATE OR REPLACE FUNCTION tasks_sync_title_name() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.name  := COALESCE(NEW.name, NEW.title);
        NEW.title := COALESCE(NEW.title, NEW.name);
    ELSIF NEW.name IS DISTINCT FROM OLD.name THEN
        NEW.title := NEW.name;
    ELSIF NEW.title IS DISTINCT FROM OLD.title THEN
        NEW.name := NEW.title;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tasks_sync_title_name
    BEFORE INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION tasks_sync_title_name();

-- Backfill. Fine for TaskFlow's size; on millions of rows batch it (see exercises).
UPDATE tasks SET name = title WHERE name IS NULL;
~~~

Note the PostgreSQL dollar-quoting ^$$^ is allowed: it is a dollar sign not followed by a brace. Release N+1 changes the entity to ^@Column(name = "name")^ and stops using ^title^ (it must still be nullable-safe because old pods insert only ^title^, which the trigger copies). Release N+2, after every pod runs N+1, contracts:

~~~sql src/main/resources/db/migration/V6__contract_task_title.sql
SET lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_tasks_sync_title_name ON tasks;
DROP FUNCTION IF EXISTS tasks_sync_title_name();
ALTER TABLE tasks ALTER COLUMN name SET NOT NULL;
ALTER TABLE tasks DROP COLUMN title;
~~~

You would **not** add V6 to the same release as V4. It is shown here so you see the full lifecycle; keep it in a branch until the contract release. Between V4 and V6, ^ddl-auto: validate^ is happy in both versions because both columns exist.

### Step 8: V5, a concurrent index

~~~sql src/main/resources/db/migration/V5__index_tasks_due_date.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_open_due_date
    ON tasks (project_id, due_date)
    WHERE deleted_at IS NULL AND status <> 'DONE';
~~~

~~~properties src/main/resources/db/migration/V5__index_tasks_due_date.sql.conf
executeInTransaction=false
~~~

This index serves the overdue and next-due-date queries from lesson 8.1. If the build fails, check for an invalid index and drop it before re-running:

~~~sql
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
DROP INDEX CONCURRENTLY IF EXISTS idx_tasks_open_due_date;
~~~

### Step 9: A repeatable view and dev seed data

~~~sql src/main/resources/db/migration/R__task_overview_view.sql
CREATE OR REPLACE VIEW task_overview AS
SELECT t.id, t.project_id, p.name AS project_name, t.status, t.due_date,
       (SELECT count(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
FROM tasks t
JOIN projects p ON p.id = t.project_id
WHERE t.deleted_at IS NULL;

GRANT SELECT ON task_overview TO §{app_role};
~~~

Edit this file whenever the view changes; Flyway re-runs it after all versioned migrations because its checksum changed. A view that references ^title^ would block the V6 contract, which is one more reason to keep views in repeatables and update them before contracting.

~~~sql src/main/resources/db/dev-data/V1000__demo_data.sql
INSERT INTO users (email, display_name, password_hash, role)
VALUES ('julian@example.com', 'Julian', '{bcrypt}$2a$10$7EqJtq98hPqEX7fNZaFWoO5rP6s3b1xW0Yb0m3cQk6xQ8U9L2pG3e', 'USER')
ON CONFLICT (email) DO NOTHING;
~~~

The high version 1000 keeps demo data after every real migration. Because it lives in ^db/dev-data^, which only the dev profile includes, production never sees it. Be aware that a dev database that ran V1000 will report V1000 as the current version; real migrations below 1000 still apply only with ^out-of-order^ enabled in dev, or you can use a Java callback (^afterMigrate^) for seeding instead. Many teams prefer the callback approach for exactly this reason.

### Step 10: Testing migrations with Testcontainers

~~~java src/test/java/com/example/taskflow/migration/FlywayMigrationIT.java
package com.example.taskflow.migration;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@Testcontainers
class FlywayMigrationIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine")
            .withUsername("taskflow");

    @Container
    @ServiceConnection(name = "redis")
    static GenericContainer<?> redis = new GenericContainer<>("redis:7.4-alpine").withExposedPorts(6379);

    @Autowired Flyway flyway;
    @Autowired JdbcTemplate jdbc;

    @Test
    void allMigrationsApplySuccessfullyOnRealPostgres() {
        MigrationInfo[] applied = flyway.info().applied();
        assertThat(applied).isNotEmpty();
        assertThat(Arrays.stream(applied).allMatch(m -> m.getState().isApplied() && !m.getState().isFailed()))
                .isTrue();
        assertThat(flyway.info().pending()).isEmpty();
        // Context started, so Hibernate validate also passed against the migrated schema.
    }

    @Test
    void softDeleteColumnAndCommentsTableExist() {
        Integer cols = jdbc.queryForObject("""
                SELECT count(*) FROM information_schema.columns
                WHERE table_name = 'tasks' AND column_name = 'deleted_at'
                """, Integer.class);
        assertThat(cols).isEqualTo(1);

        Boolean fk = jdbc.queryForObject("""
                SELECT EXISTS (SELECT 1 FROM information_schema.table_constraints
                WHERE table_name = 'comments' AND constraint_type = 'FOREIGN KEY')
                """, Boolean.class);
        assertThat(fk).isTrue();
    }

    @Test
    void concurrentIndexIsValid() {
        Boolean valid = jdbc.queryForObject("""
                SELECT i.indisvalid FROM pg_index i
                JOIN pg_class c ON c.oid = i.indexrelid
                WHERE c.relname = 'idx_tasks_open_due_date'
                """, Boolean.class);
        assertThat(valid).isTrue();
    }

    @Test
    void triggerKeepsTitleAndNameInSync() {
        Long userId = jdbc.queryForObject(
                "INSERT INTO users (email, display_name, password_hash, role) VALUES ('m@t.dev','M','x','USER') RETURNING id",
                Long.class);
        Long projectId = jdbc.queryForObject(
                "INSERT INTO projects (name, owner_id) VALUES ('P', ?) RETURNING id", Long.class, userId);
        // An OLD app version inserts only title:
        jdbc.update("INSERT INTO tasks (title, status, project_id, version) VALUES ('Old style', 'TODO', ?, 0)", projectId);
        String name = jdbc.queryForObject("SELECT name FROM tasks WHERE title = 'Old style'", String.class);
        assertThat(name).isEqualTo("Old style");
    }
}
~~~

The test uses the **same PostgreSQL major version as production**. H2 would accept different SQL, has no ^CONCURRENTLY^, no partial indexes in the same form, and no PL/pgSQL triggers, so it would give false confidence. A strong extra test, used by many teams, is to restore an anonymized production schema dump into the container and run only the new migrations on top of it.

### Step 11: Migrations in CI

~~~yaml .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"
          cache: maven
      - name: Reject edits to already-merged migrations
        if: github.event_name == 'pull_request'
        run: |
          git fetch origin main --depth=1
          CHANGED=$(git diff --name-only --diff-filter=MDR origin/main -- src/main/resources/db/migration | grep '/V' || true)
          if [ -n "$CHANGED" ]; then echo "Applied migrations must not be modified: $CHANGED"; exit 1; fi
      - name: Build, unit and Testcontainers tests
        run: ./mvnw -B verify
~~~

The guard step fails any pull request that modifies, deletes or renames an existing versioned migration (new files are allowed). In the deployment pipeline, run migrations as a **separate step or Kubernetes Job** before rolling out the new pods, with ^spring.flyway.enabled=false^ on the app itself, so a slow migration never trips liveness probes and only one process ever migrates. For small apps, migrating on startup with Flyway's lock is acceptable.

## 3. Common Pitfalls & Best Practices

- **Editing an applied migration:** checksum mismatch blocks startup and environments diverge. Fix: treat merged migrations as immutable and add a new version; enforce it in CI.
- **Breaking renames and drops in one release:** old pods fail during rolling deploys. Fix: expand/contract across releases, with a sync trigger or dual writes.
- **Plain CREATE INDEX on a big table:** writes are blocked for minutes. Fix: ^CREATE INDEX CONCURRENTLY^ in its own migration with ^executeInTransaction=false^, and check for invalid leftovers.
- **No lock_timeout:** a migration waiting for a lock queues every query and causes an outage. Fix: ^SET lock_timeout^ at the top of risky migrations and retry.
- **Adding NOT NULL in one step to a populated table:** fails or locks. Fix: nullable column, backfill in batches, ^NOT VALID^ check, ^VALIDATE^, then ^SET NOT NULL^.
- **ddl-auto update or create in shared environments:** Hibernate fights Flyway. Fix: ^validate^ everywhere.
- **Testing migrations on H2:** dialect differences hide real failures. Fix: Testcontainers with the production PostgreSQL version.
- **Demo data in the main migration folder:** fake users reach production. Fix: separate location per profile or an ^afterMigrate^ callback.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Add task priority safely","tasks":["Write ^V7__add_task_priority.sql^ that adds a ^priority^ column (VARCHAR(10)) as nullable, with ^SET lock_timeout^ at the top.","Add a matching enum ^TaskPriority^ (LOW, MEDIUM, HIGH) and map it in ^Task^ with ^@Enumerated(EnumType.STRING)^; make the API default to MEDIUM.","Write ^V8__backfill_task_priority.sql^ that backfills existing rows in batches of 1,000 (hint: a DO block with a loop over ^ctid^ or ids), then adds a ^NOT VALID^ check constraint and validates it.","Extend ^FlywayMigrationIT^ to assert the column exists, the constraint is valid, and no row has a NULL priority.","Inspect ^flyway_schema_history^ and explain each new row."]},
{"title":"Exercise 2 (Challenge): Break it on purpose","tasks":["On a local database, edit a comment inside ^V2__create_comments.sql^, start the app, and record the exact error. Then restore the file and explain when ^flyway repair^ would be appropriate instead.","Read the Flyway documentation for ^baseline^ and simulate adoption: create a database by running V1 manually with psql, then start TaskFlow with ^baseline-on-migrate^ and ^baseline-version: 1^ and show that only V2 and later run.","Remove the ^.conf^ file for V5, run the migration against a fresh container, and capture the error. Explain why Flyway's default transaction causes it.","Create a hotfix migration ^V5.1__^ after V6 has been applied and observe Flyway's behavior with and without ^out-of-order^."]},
{"title":"Exercise 3 (Thinking): Plan a zero-downtime change","tasks":["TaskFlow must split ^users.display_name^ into ^first_name^ and ^last_name^. Write a release-by-release expand/contract plan (database steps and application steps per release) that allows rolling back code at every stage.","Explain why forward-only fixes are usually safer than down-migrations, using a concrete example involving the ^comments^ table.","Compare how you would implement V2 and V3 in Liquibase YAML changesets and list two advantages and two disadvantages relative to Flyway for TaskFlow.","Argue for or against running Flyway on application startup versus as a separate deployment job for a 6-replica Kubernetes deployment."]}
]
};
