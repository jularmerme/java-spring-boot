LESSONS['3.1']={
md:String.raw`## 1. Concept & Theory

### Where the project stands

At the end of Module 2 our **Bookstore API** is a clean, layered REST service: ^BookController^ receives requests, validates ^BookRequest^ records, delegates to ^BookService^, returns ^BookResponse^ records and turns failures into RFC 9457 ^ProblemDetail^ responses through ^GlobalExceptionHandler^. There is one big lie in it, though: ^BookService^ stores everything in a ^ConcurrentHashMap^. Restart the app and every book is gone. Run two instances behind a load balancer and each has its own private, inconsistent "database".

In this lesson we fix the storage foundation. We add Spring Data JPA, connect to **H2** (an in-memory database for fast local development) and then to **PostgreSQL** (a real production database), and we turn ^Book^ into a proper JPA **entity**. In Lesson 3.2 we will replace the Map with a repository; in Lesson 3.3 we add relationships and transactions.

**Files in this lesson**

| File | Status |
|---|---|
| pom.xml | changed (JPA, H2, PostgreSQL driver) |
| src/main/resources/application.yml | changed (datasource, JPA settings) |
| src/main/resources/application-postgres.yml | new |
| src/main/java/com/example/bookstore/model/Book.java | changed (now an entity) |
| src/main/java/com/example/bookstore/model/BookFormat.java | new (enum) |
| src/main/java/com/example/bookstore/config/JpaAuditingConfig.java | new |
| compose.yaml | new (local PostgreSQL) |

### JPA, Hibernate and Spring Data: three layers, one stack

Beginners often use these three names interchangeably. They are three different things stacked on top of each other:

| Layer | What it is | Who provides it | Analogy |
|---|---|---|---|
| JDBC | Low-level Java API to send SQL and read result sets | The JDK plus a vendor driver (e.g. org.postgresql) | A telephone line |
| JPA (Jakarta Persistence) | A **specification**: annotations (@Entity, @Id...) and interfaces (EntityManager) that describe object-relational mapping | Jakarta EE, package jakarta.persistence | The building code that says how houses must be built |
| Hibernate ORM | The **implementation** of JPA. It generates SQL, tracks changes, caches entities | Hibernate (default in Spring Boot) | The construction company following the code |
| Spring Data JPA | A layer **on top of** JPA that generates repository implementations from interfaces | Spring | A property manager who handles the construction company for you |

So when you write ^bookRepository.findByTitle("Dune")^ in Lesson 3.2, Spring Data turns that into a JPA query, Hibernate turns the JPA query into PostgreSQL-flavoured SQL, and the JDBC driver sends that SQL over the network. Knowing the layers matters in production: when a query is slow you look at the SQL Hibernate generated; when a connection times out you look at the pool and the driver; when a repository method fails to start you look at Spring Data's query derivation.

**ORM** (object-relational mapping) solves the "impedance mismatch": Java has objects, references, inheritance and collections; relational databases have tables, rows, foreign keys and joins. Hibernate maps one to the other so you mostly think in objects, but - and this is the theme of all of Module 3 - you must still understand the SQL it produces.

### DataSource and HikariCP: the connection pool

Opening a database connection is expensive: TCP handshake, TLS, authentication, session setup - easily 20-100 ms. A REST API serving hundreds of requests per second cannot open a new connection per request. The solution is a **connection pool**: a fixed set of already-open connections that requests borrow and return.

In Java, the abstraction for "something that gives me connections" is ^javax.sql.DataSource^ (this one is part of the JDK, not Java EE, so the javax prefix is correct and not deprecated). Spring Boot's auto-configuration (^DataSourceAutoConfiguration^) sees a JDBC driver on the classpath plus the ^spring.datasource.*^ properties and creates a **HikariCP** ^HikariDataSource^ bean - Hikari is the default pool because it is the fastest and most battle-tested.

What happens under the hood on startup:

1. ^DataSourceAutoConfiguration^ creates a ^HikariDataSource^ from ^spring.datasource.url^, username and password.
1. ^HibernateJpaAutoConfiguration^ creates a ^LocalContainerEntityManagerFactoryBean^, which boots Hibernate, scans your ^@Entity^ classes (in the package of your ^@SpringBootApplication^ class and below) and builds the metamodel.
1. A ^JpaTransactionManager^ is registered so ^@Transactional^ works (Lesson 3.3).
1. Spring Data's ^JpaRepositoriesAutoConfiguration^ looks for repository interfaces (Lesson 3.2).

Key Hikari settings you will meet in production:

| Property | Default | Meaning |
|---|---|---|
| spring.datasource.hikari.maximum-pool-size | 10 | Max connections. More is NOT faster; the DB has limited cores. |
| spring.datasource.hikari.minimum-idle | same as max | Idle connections kept open |
| spring.datasource.hikari.connection-timeout | 30000 ms | How long a request waits for a free connection before failing |
| spring.datasource.hikari.max-lifetime | 1800000 ms | Recycle connections before the DB or a firewall kills them |

> A classic production incident: pool size 10, a slow query holds connections for 5 seconds, traffic spikes, all 10 are busy, new requests wait 30 seconds and then fail with "Connection is not available, request timed out". The fix is almost never "set pool size to 200" - it is fixing the slow query and keeping transactions short.

### H2: the in-memory database

H2 is a pure-Java database that can run inside your JVM. With ^jdbc:h2:mem:bookstore^ the data lives in memory and disappears on shutdown - perfect for the first iterations and for quick demos. H2 ships a web console to browse tables. Use it for learning, not as a substitute for testing against your real database: H2's SQL dialect differs from PostgreSQL in many small ways (in Module 5 we will use Testcontainers to test against a real PostgreSQL).

### PostgreSQL: the production database

PostgreSQL is the most popular open-source relational database for new backend systems. The configuration differs from H2 in only three places: the URL, the credentials and the driver. **Credentials must never be hardcoded** in a committed file. Spring's property placeholders read environment variables: ^§{DB_PASSWORD:secret}^ means "use the environment variable DB_PASSWORD, or fall back to secret if it is missing". In production you omit the fallback so a missing secret fails fast at startup instead of silently using a dev password.

### ddl-auto: who owns the schema?

Hibernate can generate the database schema from your entities. ^spring.jpa.hibernate.ddl-auto^ controls this:

| Value | What Hibernate does at startup | Use it for |
|---|---|---|
| none | Nothing | Production (with Flyway or Liquibase) |
| validate | Checks tables and columns match entities, fails startup if not | Production safety net together with Flyway |
| update | Tries to ALTER tables to match entities; never drops columns | Quick prototypes only |
| create | Drops and recreates the schema on startup | Throwaway experiments |
| create-drop | Like create, and drops on shutdown | Default for embedded DBs like H2, tests |

Why **never** ^update^ or ^create^ in production?

- ^create^ drops your tables. One misconfigured profile and the customer data is gone.
- ^update^ is not a migration tool. It cannot rename a column (it adds a new empty one), it does not drop or change types safely, it has no history, no review, no rollback, and two instances starting concurrently can race each other.
- The schema is a contract shared with DBAs, analytics, other services. Changes must be explicit, versioned, reviewed SQL.

The professional answer is a migration tool such as **Flyway**: versioned SQL files (^V1__create_book.sql^, ^V2__add_author.sql^) that run exactly once, in order, recorded in a history table. We will add Flyway in a later step; for now we use ^create-drop^ with H2 and ^validate^-ready entities, and you will see why that discipline pays off.

### Mapping an entity

An **entity** is a Java class whose instances correspond to rows of a table. The essential annotations:

| Annotation | Purpose |
|---|---|
| @Entity | Marks the class as managed by JPA. Must have an @Id and a no-arg constructor. |
| @Table(name = "books") | Table name (and optionally unique constraints, indexes). Default is the class name. |
| @Id | Primary key field |
| @GeneratedValue(strategy = ...) | Who generates the key: IDENTITY, SEQUENCE, TABLE, AUTO, UUID |
| @Column(nullable, length, unique, precision, scale) | Column details; used for DDL generation and documentation |
| @Enumerated(EnumType.STRING) | Store an enum by name rather than ordinal |
| @Version | Optimistic locking (Lesson 3.3) |

### IDENTITY vs SEQUENCE

**IDENTITY** uses an auto-increment column (^GENERATED BY DEFAULT AS IDENTITY^ / ^SERIAL^). The database assigns the id during the INSERT, so Hibernate must execute the INSERT **immediately** when you call ^persist^ to learn the id. Consequence: Hibernate cannot batch inserts (no JDBC batching).

**SEQUENCE** uses a database sequence object. Hibernate asks the sequence for the next value *before* inserting, so it can delay and batch INSERTs. With ^allocationSize = 50^ Hibernate fetches one value and hands out 50 ids from memory (pooled optimizer), so 1,000 inserts cost 20 sequence calls instead of 1,000. PostgreSQL supports sequences natively, so **SEQUENCE is the recommended strategy for PostgreSQL**. IDENTITY is fine and simpler for small apps and for MySQL (which has no sequences).

Pitfall: the ^allocationSize^ in Java must match the ^INCREMENT BY^ of the sequence in the database, otherwise ids collide or Hibernate fails validation.

### Enums: always STRING

The default ^EnumType.ORDINAL^ stores 0, 1, 2. If someone inserts a new constant in the middle of the enum, every existing row silently changes meaning. ^EnumType.STRING^ stores "HARDCOVER" - readable, safe under reordering. (Renaming a constant still requires a migration, which is honest.)

### Why entities need a no-arg constructor and are not records

Hibernate creates entity instances by reflection - for example when it loads a row it calls the no-arg constructor and then sets fields. It also creates **proxies**: subclasses generated at runtime (via ByteBuddy) that stand in for an entity until it is actually loaded (lazy loading, Lesson 3.3). Therefore:

- A no-arg constructor is required (it may be ^protected^ so your own code cannot misuse it).
- The class must not be ^final^, and persistent methods must not be final, or proxies cannot be generated.
- Fields must be mutable because Hibernate tracks and writes changes.

A Java **record** is final, its fields are final, and it has no no-arg constructor. All three contradict the entity model, so **records cannot be entities**. Records are perfect for what they are designed for: immutable DTOs (^BookRequest^, ^BookResponse^) and query projections (Lesson 3.2). This is exactly why we kept DTOs and the entity separate in Module 2.

### equals and hashCode on entities

Entities have identity based on the primary key, but the id is null until the entity is persisted. The two naive implementations both break:

- Lombok-style "all fields" equals: two loads of the same row compare unequal after one field changes; lazy collections can trigger extra queries or infinite recursion.
- "id only" with a hashCode derived from the id: an entity put into a ^HashSet^ before persisting has hashCode of null; after persist the id is set, the hashCode changes, and the set can no longer find it.

The widely recommended pattern (Vlad Mihalcea, Hibernate team): equals compares ids **only if both are non-null**, and hashCode returns a **constant per class** (^getClass().hashCode()^). It is stable across the lifecycle. Constant hash codes are only a problem for huge hash sets of entities, which you should not have anyway. If the entity has a natural immutable business key (like ISBN), you can use that instead.

Also use ^Hibernate.getClass(o)^ style comparison or ^instanceof^ rather than ^getClass() == o.getClass()^, because a Hibernate proxy is a subclass.

### Auditing: createdAt and updatedAt

Almost every production table has "when was this created / last modified". Spring Data JPA can fill these for you: annotate the entity with ^@EntityListeners(AuditingEntityListener.class)^, the fields with ^@CreatedDate^ and ^@LastModifiedDate^, and enable it with ^@EnableJpaAuditing^. Under the hood a JPA lifecycle callback (^@PrePersist^ / ^@PreUpdate^) sets the timestamps. Later, with Spring Security (Module 4), ^@CreatedBy^ can record the user.

### The persistence context and entity states

This is the most important "magic under the hood" in JPA, and the source of most confusion.

The **persistence context** is a first-level cache and change tracker owned by an ^EntityManager^ (in Spring, typically one per transaction). Think of it as a **workbench**: entities on the workbench are watched by Hibernate; when the transaction commits, Hibernate compares each entity with the snapshot it took when it was loaded (**dirty checking**) and issues UPDATE statements for whatever changed. You never call "save" for a managed entity - changing a field is enough.

An entity is always in one of four states:

| State | Meaning | How it gets there |
|---|---|---|
| Transient (new) | Plain Java object, not known to Hibernate, no row | new Book(...) |
| Managed (persistent) | On the workbench; changes are tracked and flushed | persist(), find(), query results, merge() return value |
| Detached | Has an id and a row, but its persistence context is closed | Transaction ends, clear(), detach(), serialized to JSON |
| Removed | Scheduled for DELETE at flush | remove() on a managed entity |

Three consequences that matter in production:

1. **Identity guarantee**: inside one persistence context, loading the same id twice returns the **same Java object** and only one SELECT.
1. **Flush timing**: SQL is not sent when you call persist or change a field; it is sent at **flush** - before commit, before a query that might be affected, or on an explicit ^flush()^. So a constraint violation may surface at commit time, not at the line that caused it.
1. **Detached entities do not track changes**: modifying an entity after the transaction ended does nothing. This is also why lazy collections fail outside a transaction (Lesson 3.3).

### Seeing the SQL

You cannot reason about JPA performance without seeing SQL. ^spring.jpa.show-sql=true^ prints statements to stdout (quick and dirty). Better is ^spring.jpa.properties.hibernate.format_sql=true^ plus the logger ^org.hibernate.SQL: debug^ which goes through your logging framework, and ^org.hibernate.orm.jdbc.bind: trace^ to see bound parameter values. Use them in dev; in production keep them off (noise, and parameter values can contain personal data).

## 2. Code Walkthrough

### Step 1: dependencies

Add three dependencies. The JPA starter brings Hibernate, Spring Data JPA, HikariCP and the transaction support. The drivers are ^runtime^ scope because your code never imports them directly.

~~~xml pom.xml (dependencies section)
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

    <!-- NEW in 3.1: JPA = Hibernate + Spring Data JPA + HikariCP -->
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
    <!-- NEW: in-memory DB for local development -->
    <dependency>
        <groupId>com.h2database</groupId>
        <artifactId>h2</artifactId>
        <scope>runtime</scope>
    </dependency>
    <!-- NEW: PostgreSQL JDBC driver -->
    <dependency>
        <groupId>org.postgresql</groupId>
        <artifactId>postgresql</artifactId>
        <scope>runtime</scope>
    </dependency>

    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-devtools</artifactId>
        <scope>runtime</scope>
        <optional>true</optional>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-test</artifactId>
        <scope>test</scope>
    </dependency>
</dependencies>
~~~

Versions are managed by the Spring Boot parent (3.4.x), so no version tags are needed.

### Step 2: H2 configuration (default profile)

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: bookstore
  datasource:
    url: jdbc:h2:mem:bookstore;DB_CLOSE_DELAY=-1
    username: sa
    password:
    hikari:
      maximum-pool-size: 10
      connection-timeout: 5000
  h2:
    console:
      enabled: true
      path: /h2-console
  jpa:
    hibernate:
      ddl-auto: create-drop
    open-in-view: false
    show-sql: false
    properties:
      hibernate:
        format_sql: true
  data:
    web:
      pageable:
        max-page-size: 100

logging:
  level:
    org.hibernate.SQL: debug
    org.hibernate.orm.jdbc.bind: trace
~~~

Notes on each choice:

- ^DB_CLOSE_DELAY=-1^ keeps the in-memory DB alive as long as the JVM runs (otherwise it vanishes when the last connection closes).
- ^open-in-view: false^ - we switch off a Spring Boot default that keeps the persistence context open during view rendering. Lesson 3.3 explains why it is harmful; disabling it now also silences the startup warning.
- We log SQL through ^org.hibernate.SQL^ rather than ^show-sql^ so it goes through Logback with timestamps and thread names.
- The pageable max size is preparation for Lesson 3.2.

### Step 3: the enum

~~~java src/main/java/com/example/bookstore/model/BookFormat.java
package com.example.bookstore.model;

public enum BookFormat {
    HARDCOVER,
    PAPERBACK,
    EBOOK,
    AUDIOBOOK
}
~~~

### Step 4: Book becomes an entity

In Module 2, ^Book^ was a simple domain class held in the Map. Now it is a full entity. Read the comments carefully - every line has a reason.

~~~java src/main/java/com/example/bookstore/model/Book.java
package com.example.bookstore.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.SequenceGenerator;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Objects;

@Entity
@Table(name = "books",
       uniqueConstraints = @UniqueConstraint(name = "uk_books_isbn", columnNames = "isbn"))
@EntityListeners(AuditingEntityListener.class)
public class Book {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "book_seq")
    @SequenceGenerator(name = "book_seq", sequenceName = "book_seq", allocationSize = 50)
    private Long id;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(nullable = false, length = 17)
    private String isbn;

    // precision = total digits, scale = digits after the decimal point -> NUMERIC(10,2)
    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    @Column(name = "published_year", nullable = false)
    private int publishedYear;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private BookFormat format = BookFormat.PAPERBACK;

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /** Required by JPA. Protected so application code uses the real constructor. */
    protected Book() {
    }

    public Book(String title, String isbn, BigDecimal price, int publishedYear) {
        this.title = title;
        this.isbn = isbn;
        this.price = price;
        this.publishedYear = publishedYear;
    }

    /** Domain method instead of four blind setters: keeps updates intentional. */
    public void updateDetails(String title, String isbn, BigDecimal price, int publishedYear) {
        this.title = title;
        this.isbn = isbn;
        this.price = price;
        this.publishedYear = publishedYear;
    }

    public Long getId() { return id; }
    public String getTitle() { return title; }
    public String getIsbn() { return isbn; }
    public BigDecimal getPrice() { return price; }
    public int getPublishedYear() { return publishedYear; }
    public BookFormat getFormat() { return format; }
    public void setFormat(BookFormat format) { this.format = format; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Book other)) return false;   // instanceof also matches Hibernate proxies
        return id != null && Objects.equals(id, other.getId());
    }

    @Override
    public int hashCode() {
        // Constant per class: stable before and after persist (id goes from null to a value)
        return Book.class.hashCode();
    }

    @Override
    public String toString() {
        // Never include lazy associations here (Lesson 3.3) - toString would trigger queries
        return "Book[id=" + id + ", title=" + title + ", isbn=" + isbn + "]";
    }
}
~~~

Design decisions to notice:

- **No public setter for id**: the database owns it.
- **Unique constraint on ISBN**: business rules belong in the database too. Application checks race; constraints do not.
- **NUMERIC(10,2) for money**: never ^double^ in Java, never FLOAT in SQL.
- **^other.getId()^ in equals** rather than ^other.id^: on a proxy, field access returns null because the proxy's own fields are never initialized; the getter delegates to the real object.
- **A domain method ^updateDetails^** rather than setters for everything - the entity exposes intentions.

### Step 5: enable auditing

~~~java src/main/java/com/example/bookstore/config/JpaAuditingConfig.java
package com.example.bookstore.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;

@Configuration
@EnableJpaAuditing
public class JpaAuditingConfig {
}
~~~

Why a separate configuration class instead of putting ^@EnableJpaAuditing^ on the main class? Sliced tests such as ^@WebMvcTest^ (Module 5) load the main class; if it carries JPA annotations, those tests fail because there is no JPA infrastructure. Keeping infrastructure toggles in ^config^ classes is a good habit.

### Step 6: run with H2 and look at the schema

~~~powershell
.\mvnw spring-boot:run
~~~

In the log you will see Hibernate creating the schema (formatted thanks to format_sql):

~~~text
DEBUG org.hibernate.SQL :
    create sequence book_seq start with 1 increment by 50
DEBUG org.hibernate.SQL :
    create table books (
        price numeric(10,2) not null,
        published_year integer not null,
        created_at timestamp(6) with time zone not null,
        id bigint not null,
        updated_at timestamp(6) with time zone not null,
        format varchar(20) not null check (format in ('HARDCOVER','PAPERBACK','EBOOK','AUDIOBOOK')),
        isbn varchar(17) not null,
        title varchar(200) not null,
        primary key (id)
    )
DEBUG org.hibernate.SQL :
    alter table if exists books
       add constraint uk_books_isbn unique (isbn)
~~~

Notice Hibernate 6 even generated a CHECK constraint for the enum. Open **http://localhost:8080/h2-console**, use JDBC URL ^jdbc:h2:mem:bookstore^, user ^sa^, empty password, and run:

~~~sql
SELECT * FROM BOOKS;
SELECT * FROM INFORMATION_SCHEMA.SEQUENCES;
~~~

The table is empty - our ^BookService^ still uses the Map. That changes in Lesson 3.2. To prove the mapping works right now, add a temporary seeder that uses the ^EntityManager^ directly (we will delete it in 3.2 when the repository arrives):

~~~java src/main/java/com/example/bookstore/config/DevDataSeeder.java
package com.example.bookstore.config;

import com.example.bookstore.model.Book;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

@Component
@Profile("!postgres")
public class DevDataSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DevDataSeeder.class);
    private final EntityManager entityManager;

    public DevDataSeeder(EntityManager entityManager) {
        this.entityManager = entityManager;   // a thread-safe shared proxy, not a raw EntityManager
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        Book dune = new Book("Dune", "978-0441172719", new BigDecimal("9.99"), 1965);   // TRANSIENT
        entityManager.persist(dune);                                                     // MANAGED
        log.info("After persist, id = {} (no INSERT sent yet with SEQUENCE)", dune.getId());

        dune.updateDetails("Dune (Anniversary Edition)", dune.getIsbn(), new BigDecimal("12.99"), 1965);
        // No save call: dirty checking will include the change in the INSERT at flush.

        Book sameRow = entityManager.find(Book.class, dune.getId());
        log.info("Same instance from persistence context? {}", sameRow == dune);          // true, no SELECT

        entityManager.persist(new Book("Clean Code", "978-0132350884", new BigDecimal("37.50"), 2008));
        log.info("Leaving method -> transaction commits -> flush");
    }
}
~~~

Restart and read the log carefully:

~~~text
DEBUG org.hibernate.SQL : select next value for book_seq
INFO  DevDataSeeder     : After persist, id = 1 (no INSERT sent yet with SEQUENCE)
INFO  DevDataSeeder     : Same instance from persistence context? true
INFO  DevDataSeeder     : Leaving method -> transaction commits -> flush
DEBUG org.hibernate.SQL : insert into books (created_at,format,isbn,price,published_year,title,updated_at,id) values (?,?,?,?,?,?,?,?)
TRACE org.hibernate.orm.jdbc.bind : binding parameter (6:VARCHAR) <- [Dune (Anniversary Edition)]
DEBUG org.hibernate.SQL : insert into books (created_at,format,isbn,price,published_year,title,updated_at,id) values (?,?,?,?,?,?,?,?)
~~~

Everything from the theory section is visible: one sequence call served both ids (pooled allocation of 50), the INSERTs are delayed until commit, the title change is folded into the INSERT, and ^find^ returned the very same object without a SELECT. Query the H2 console again and you will see two rows with audit timestamps filled in.

> The injected ^EntityManager^ is actually a shared proxy created by Spring. Each call is routed to the EntityManager bound to the current transaction on the current thread. That is why it is safe to inject it into a singleton.

### Step 7: PostgreSQL with Docker Compose

Create a local PostgreSQL. Spring Boot 3.1+ has Docker Compose support, but we start it manually here so you understand each piece.

~~~yaml compose.yaml
services:
  postgres:
    image: postgres:17
    container_name: bookstore-db
    environment:
      POSTGRES_DB: bookstore
      POSTGRES_USER: bookstore
      POSTGRES_PASSWORD: §{DB_PASSWORD:-secret}
    ports:
      - "5432:5432"
    volumes:
      - bookstore-data:/var/lib/postgresql/data

volumes:
  bookstore-data:
~~~

~~~powershell
docker compose up -d
docker compose ps
~~~

Now a profile-specific config file. Spring loads ^application-postgres.yml^ on top of ^application.yml^ when the ^postgres^ profile is active, overriding only what is listed.

~~~yaml src/main/resources/application-postgres.yml
spring:
  datasource:
    url: jdbc:postgresql://§{DB_HOST:localhost}:§{DB_PORT:5432}/§{DB_NAME:bookstore}
    username: §{DB_USER:bookstore}
    password: §{DB_PASSWORD:secret}
    hikari:
      maximum-pool-size: §{DB_POOL_SIZE:10}
  h2:
    console:
      enabled: false
  jpa:
    hibernate:
      # Local dev only. Production: none or validate + Flyway migrations.
      ddl-auto: update
~~~

We use ^update^ here only temporarily for local learning so the table exists in PostgreSQL. Once you add Flyway, this becomes ^validate^. Run it:

~~~powershell
$env:SPRING_PROFILES_ACTIVE = "postgres"
$env:DB_PASSWORD = "secret"
.\mvnw spring-boot:run
~~~

You should see a log line like ^HikariPool-1 - Added connection org.postgresql.jdbc.PgConnection^ and Hibernate's DDL in the PostgreSQL dialect (^bigint^, ^numeric(10,2)^, ^timestamp(6) with time zone^). Inspect the database:

~~~powershell
docker exec -it bookstore-db psql -U bookstore -d bookstore -c "\d books"
~~~

~~~text
                         Table "public.books"
     Column     |            Type             | Nullable
----------------+-----------------------------+----------
 price          | numeric(10,2)               | not null
 published_year | integer                     | not null
 created_at     | timestamp(6) with time zone | not null
 id             | bigint                      | not null
 updated_at     | timestamp(6) with time zone | not null
 format         | character varying(20)       | not null
 isbn           | character varying(17)       | not null
 title          | character varying(200)      | not null
Indexes:
    "books_pkey" PRIMARY KEY, btree (id)
    "uk_books_isbn" UNIQUE CONSTRAINT, btree (isbn)
~~~

Also check the health endpoint - Actuator automatically adds a database health indicator once a DataSource exists:

~~~powershell
curl http://localhost:8080/actuator/health
~~~

~~~json
{"status":"UP"}
~~~

(With ^management.endpoint.health.show-details=always^ you would see a ^db^ component with ^"database": "PostgreSQL"^ and the validation query result. Module 6 covers this in depth.)

### Step 8: what happens when the DB is down?

Stop the container (^docker compose stop^) and start the app with the postgres profile. Hikari tries to connect at startup and fails; Spring refuses to start with a clear "Connection to localhost:5432 refused" error. That is the behaviour you want: fail fast at deployment rather than accept traffic you cannot serve. Start the container again before moving on.

## 3. Common Pitfalls & Best Practices

- **Mistake:** ^ddl-auto: update^ (or ^create^) in production. **Fix:** use ^none^ or ^validate^ in production and manage the schema with versioned Flyway migrations; keep generated DDL only for throwaway local databases.
- **Mistake:** hardcoding the database password in ^application.yml^ and committing it. **Fix:** placeholders such as ^§{DB_PASSWORD}^ read from environment variables or a secret manager; no fallback value for secrets in production config.
- **Mistake:** ^@Enumerated^ left at the default ORDINAL. **Fix:** always ^@Enumerated(EnumType.STRING)^ so reordering enum constants cannot corrupt data.
- **Mistake:** using a record, a final class, or a Lombok ^@Data^ class as an entity. **Fix:** a non-final class with a protected no-arg constructor, explicit getters, intention-revealing methods, and equals/hashCode based on the id with a constant hashCode.
- **Mistake:** using ^double^ for prices. **Fix:** ^BigDecimal^ with ^@Column(precision = 10, scale = 2)^.
- **Mistake:** expecting a field change on an entity to be saved after the transaction ended. **Fix:** understand entity states; modify managed entities inside a transactional service method, where dirty checking flushes them at commit.
- **Mistake:** a mismatch between ^allocationSize^ and the sequence ^INCREMENT BY^, causing duplicate key errors. **Fix:** keep them identical (50 and 50), and define both in the Flyway migration once you add it.
- **Mistake:** cranking ^maximum-pool-size^ to hundreds to "fix" timeouts. **Fix:** find the slow query or long transaction; a small pool (roughly cores times two on the DB server) usually performs best.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Map and inspect the Book entity","tasks":["Add the JPA, H2 and PostgreSQL dependencies and the H2 configuration, then start the app and find the generated ^create table books^ statement in the log.","Open the H2 console and confirm the table, the ^book_seq^ sequence and the ^uk_books_isbn^ constraint exist.","Add the temporary ^DevDataSeeder^ and verify in the log that only one sequence call was made for both books and that the INSERTs happen after the 'Leaving method' line.","Try inserting a third book with a duplicate ISBN in the seeder and observe at which moment the exception appears (and why it is at commit, not at persist).","Temporarily switch the id strategy to ^GenerationType.IDENTITY^ and compare when the INSERT is sent; then switch back to SEQUENCE."]},
{"title":"Exercise 2 (Challenge): Run against PostgreSQL the production way","tasks":["Start PostgreSQL with the ^compose.yaml^ and run the app with the ^postgres^ profile, passing the password through an environment variable only.","Write the schema yourself as a Flyway-style SQL file ^V1__create_books.sql^ (sequence with INCREMENT BY 50, table, unique constraint) and run it with psql against a fresh database.","Change ^ddl-auto^ to ^validate^ and start the app; then deliberately change ^length = 200^ to a column type mismatch (e.g. make ^publishedYear^ a ^String^) and read the validation error.","Configure Hikari with ^maximum-pool-size: 3^ and ^connection-timeout: 2000^ and explain in two sentences what a client would experience if four long transactions ran at once.","Read the Spring Boot reference section on Data Access / Configure a DataSource and list two other properties you would set for production."]},
{"title":"Exercise 3 (Thinking): Entity identity and the persistence context","tasks":["Explain in your own words why a Java record cannot be a JPA entity, naming at least three concrete reasons.","Describe what would go wrong if ^hashCode^ returned ^Objects.hash(id)^ and you added a new Book to a ^HashSet^ before persisting it.","For each of the four entity states, give one line of code that puts a Book into that state.","Explain why the ^equals^ method uses ^other.getId()^ instead of ^other.id^, referring to Hibernate proxies."]}
]
};
