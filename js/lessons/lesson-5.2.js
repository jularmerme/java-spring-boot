LESSONS['5.2']={
md:String.raw`## 1. Concept & Theory

### Where the project stands

In Lesson 5.1 you unit-tested ^BookService^ with a mocked ^BookRepository^ and a fixed ^Clock^. Those tests are fast and precise, but they deliberately ignore everything Spring does around the service: JSON (de)serialization, Bean Validation, the ^GlobalExceptionHandler^ that produces ^ProblemDetail^ bodies, Spring Security's filter chain and JWT checks, JPA mappings, the SQL that Hibernate generates and PostgreSQL's real behaviour. A unit test can be perfectly green while the endpoint returns 403 or the derived query fails on startup.

This lesson closes that gap with **integration tests**: tests that let Spring wire real components together and check that they cooperate.

**New/changed files in this lesson:**

- ^pom.xml^ (changed: Testcontainers dependencies, Failsafe plugin)
- ^src/test/resources/application-test.yml^ (new: test profile)
- ^src/test/resources/sql/books.sql^ (new: test data)
- ^src/test/java/com/example/bookstore/controller/BookControllerWebMvcTest.java^ (new: web slice)
- ^src/test/java/com/example/bookstore/repository/BookRepositoryDataJpaTest.java^ (new: JPA slice on real PostgreSQL)
- ^src/test/java/com/example/bookstore/TestcontainersConfiguration.java^ (new: shared container)
- ^src/test/java/com/example/bookstore/AbstractIntegrationTest.java^ (new: base class)
- ^src/test/java/com/example/bookstore/BookApiIT.java^ (new: full end-to-end test with real JWT)

The security classes from Module 4 are used as they are: ^SecurityConfig^ (stateless, ^/api/auth/**^ public, ^GET /api/books/**^ public, writes require ^ROLE_ADMIN^), ^JwtService^ (with ^generateToken(UserDetails)^), ^JwtAuthenticationFilter^, and ^AuthController^ with ^POST /api/auth/login^.

### Analogy: testing a car

A unit test is testing the engine on a bench. A slice test is putting the engine into a chassis with the gearbox and checking that the wheels turn. A full integration test is driving the car around the block. You need all three, in pyramid proportions: many bench tests, a solid number of chassis tests, a few drives.

### Slice tests vs full tests

Spring Boot offers **test slices**: annotations that start a **partial** application context containing only the beans for one layer. The magic under the hood is in ^spring-boot-test-autoconfigure^: each slice annotation carries a ^@TypeExcludeFilters^ filter that limits component scanning, plus an ^@ImportAutoConfiguration^ list of only the relevant auto-configurations (look in the jar for files named like ^META-INF/spring/org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureWebMvc.imports^).

| Annotation | What is in the context | What is NOT | Typical speed | Use for |
|---|---|---|---|---|
| @WebMvcTest(BookController.class) | Controller, ControllerAdvice, Jackson, Validation, MVC, Security filter chain, MockMvc | Services, repositories, DataSource, JPA | about 1-2 s | HTTP contract: status, JSON, validation, error bodies, security rules |
| @DataJpaTest | Entities, repositories, EntityManager, DataSource, Flyway/Liquibase, transaction per test | Controllers, services, security | about 2-4 s | Queries, mappings, constraints |
| @JsonTest | Jackson ObjectMapper, JacksonTester | Everything else | under 1 s | Custom JSON serialization |
| @SpringBootTest | The whole application | Nothing | 3-10 s | End-to-end flows across layers |

^@SpringBootTest^ has a ^webEnvironment^ attribute:

| webEnvironment | Meaning |
|---|---|
| MOCK (default) | Full context, no real server; use MockMvc via AutoConfigureMockMvc |
| RANDOM_PORT | Starts embedded Tomcat on a free port; tests send real HTTP |
| DEFINED_PORT | Uses server.port (risky: port clashes in CI) |
| NONE | No web environment at all (batch jobs, CLI apps) |

### MockMvc: HTTP without a network

**MockMvc** drives Spring MVC's ^DispatcherServlet^ directly with mock request and response objects. No socket is opened, but the request goes through the exact same path as in production: **servlet filters (including Spring Security's ^FilterChainProxy^), handler mapping, argument resolution, ^@Valid^, the controller, ^@RestControllerAdvice^, and Jackson message converters**. That is why ^@WebMvcTest^ catches the bugs unit tests miss: a missing ^@RequestBody^, a validation annotation that does nothing, a handler returning 500 instead of 404, a security rule that is too open.

Assertions use ^status()^, ^header()^, ^content()^ and **jsonPath** (Jayway JsonPath expressions like ^$.title^ or ^$.content.length()^).

### @MockBean is out, @MockitoBean is in

In a slice test the controller still needs a ^BookService^, but the slice does not contain one. You put a Mockito mock **into the Spring context**. For years that was ^@MockBean^ from Spring Boot. **Spring Framework 6.2 (used by Spring Boot 3.4) introduced ^@MockitoBean^ and ^@MockitoSpyBean^** in ^org.springframework.test.context.bean.override.mockito^, and Boot 3.4 **deprecated ^@MockBean^ and ^@SpyBean^**. Per the course rule we never use deprecated APIs, so this lesson uses ^@MockitoBean^ everywhere. In older tutorials, read ^@MockBean^ as the same idea.

Under the hood, ^@MockitoBean^ is part of Spring's new "bean override" mechanism: before the context refreshes, a ^BeanFactoryPostProcessor^ replaces (or registers) the bean definition for that type with a Mockito mock, and a test execution listener resets the mock after each test so stubs never leak between tests.

### Context caching and the true cost of @DirtiesContext

Starting a Spring context is the expensive part of an integration test. Spring's ^TestContext^ framework therefore **caches contexts** in a static map for the lifetime of the test JVM. The cache key is built from the whole test configuration: the configuration classes, active profiles, ^@TestPropertySource^ and dynamic properties, the set of ^@MockitoBean^ overrides, context customizers (e.g. ^@ServiceConnection^ containers) and more. Two test classes with identical configuration **share one context**; the second class starts instantly.

Every difference creates a new context. The classic slow-suite mistake: each test class mocks a different bean, uses a different profile, or adds a slightly different property, so the suite starts 25 contexts instead of 3. The default cache size is 32 (^spring.test.context.cache.maxSize^); when it is exceeded, least-recently-used contexts are closed.

^@DirtiesContext^ tells Spring "this test broke the context, throw it away". The **next** test with the same configuration must then start a fresh one. Used on many classes, it can easily turn a 40-second suite into a 6-minute suite. Prefer resetting **data** (transaction rollback, ^@Sql^ cleanup) over resetting the **context**. Turn on ^logging.level.org.springframework.test.context.cache=DEBUG^ to see cache hits and misses.

### Why H2 in tests can lie

Lesson 3.1 started on H2 for convenience. Using H2 in tests while production runs PostgreSQL is a trap that bites real teams:

| Behaviour | H2 (even in PostgreSQL mode) | Real PostgreSQL |
|---|---|---|
| Native queries and functions | Many PG functions missing or different (ILIKE, jsonb, date_trunc) | Works |
| Case sensitivity of LIKE | Differs depending on mode | Case-sensitive; ILIKE for insensitive |
| Unique constraint and error codes | Different SQLState and messages | 23505 unique_violation |
| Types | No jsonb, arrays, enums behave differently | Full type system |
| Sequences and identity | Subtle differences in IDENTITY handling | Real behaviour |
| Transaction isolation and locking | Different locking model | MVCC, real isolation behaviour |
| Flyway migrations | PG-specific SQL may fail or be skipped | Same scripts as production |

"Green on H2, red in production" means the test gave you false confidence, which is worse than no test. **Testcontainers** fixes it by starting a real PostgreSQL in Docker for the tests.

### Testcontainers and @ServiceConnection

**Testcontainers** is a Java library that starts throwaway Docker containers from tests, waits until they are ready, and removes them afterwards (a helper container called **Ryuk** cleans up even if the JVM crashes).

The old way to connect Spring to the container was ^@DynamicPropertySource^, copying the JDBC URL, user and password into properties. **Spring Boot 3.1 added ^@ServiceConnection^**: annotate a container bean or field and Boot creates a ^JdbcConnectionDetails^ bean from it. DataSource auto-configuration prefers ^ConnectionDetails^ beans over ^spring.datasource.*^ properties, so the app connects to the container automatically. Same for Redis, Kafka, RabbitMQ, MongoDB and others.

Two ways to declare containers:

| Style | How | Lifecycle |
|---|---|---|
| JUnit extension | @Testcontainers on class, @Container on a static field | Started before the class, stopped after it (static) or per test (instance field) |
| Spring bean | @TestConfiguration with a @Bean @ServiceConnection PostgreSQLContainer | Started with the context, stopped when the context closes; shared by every test that reuses that cached context |

**Static container reuse.** A container per test method would cost seconds each. A **static** field means one container per class. The bean style goes further: the container lives as long as the cached context, so every integration test class with the same configuration shares one PostgreSQL. That is the setup Spring Initializr generates (^TestcontainersConfiguration^) and the one we use for the full tests. (Testcontainers also has an opt-in ^withReuse(true)^ that keeps a container alive across JVM runs; it needs ^testcontainers.reuse.enable=true^ in ^~/.testcontainers.properties^ and is for local development only.)

### Docker Desktop on Windows

Testcontainers needs a Docker daemon. On Windows 10/11 install **Docker Desktop** with the **WSL 2 backend**, start it, and check with ^docker info^ in PowerShell. Testcontainers finds the daemon through the named pipe ^npipe:////./pipe/docker_engine^ automatically. If Docker is not running, tests fail with "Could not find a valid Docker environment". In company networks, the first ^postgres:16-alpine^ pull may need proxy settings in Docker Desktop. Corporate laptops without Docker can use Testcontainers Cloud or a remote Docker host, but the code stays identical.

### Surefire vs Failsafe: *Test vs *IT

Maven has two test plugins:

| Plugin | Phase | Default includes | Meant for | On failure |
|---|---|---|---|---|
| Surefire | test | Classes ending in Test, Tests or TestCase, or starting with Test | Unit and fast slice tests | Stops the build immediately |
| Failsafe | integration-test then verify | Classes ending in IT or ITCase, or starting with IT | Slow integration tests | Runs post-integration-test cleanup, then fails in verify |

So: ^.\mvnw test^ runs only Surefire (fast feedback, many times a day). ^.\mvnw verify^ runs both (before pushing and in CI). Spring Boot's parent POM pre-configures Failsafe, but you still have to **declare** it in your build. In this lesson the slice tests are named ^*Test^ and the full end-to-end test is named ^BookApiIT^.

### Security testing toolkit

^spring-security-test^ provides:

- ^@WithMockUser(roles = "ADMIN")^: puts an authenticated ^UsernamePasswordAuthenticationToken^ into the ^SecurityContext^ for the test, bypassing login. Good for testing **authorization rules** in slice tests.
- ^SecurityMockMvcRequestPostProcessors^: ^csrf()^, ^user(...)^, ^jwt()^ (for resource-server setups), ^httpBasic(...)^.
- For **our** custom JWT filter (Module 4), the most honest test is end-to-end: log in or ask ^JwtService^ for a real token, send ^Authorization: Bearer ...^, and let the real filter validate it.

---

## 2. Code Walkthrough

### Step 1: Dependencies and the Failsafe plugin

Add to the ^dependencies^ section (versions come from the Spring Boot BOM, which manages the Testcontainers BOM):

~~~xml pom.xml
<!-- ===== test dependencies (add next to spring-boot-starter-test and spring-security-test) ===== -->
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

<!-- ===== in build/plugins, next to spring-boot-maven-plugin and jacoco ===== -->
<plugin>
    <groupId>org.apache.maven.plugins</groupId>
    <artifactId>maven-failsafe-plugin</artifactId>
    <executions>
        <execution>
            <goals>
                <goal>integration-test</goal>
                <goal>verify</goal>
            </goals>
        </execution>
    </executions>
</plugin>
~~~

Note: ^WebTestClient^ requires ^spring-webflux^ on the test classpath, so we use **^TestRestTemplate^** and **^RestClient^** in this lesson, which work with Spring MVC only.

### Step 2: The test profile

~~~yaml src/test/resources/application-test.yml
spring:
  jpa:
    hibernate:
      ddl-auto: create-drop     # Lesson 6 / Flyway would use validate instead
    open-in-view: false
    properties:
      hibernate:
        format_sql: true
  sql:
    init:
      mode: never              # no data.sql in tests; each test sets up its own data

app:
  jwt:
    # test-only key, at least 256 bits; never reuse production secrets
    secret: dGVzdC1zZWNyZXQta2V5LWZvci1ib29rc3RvcmUtaW50ZWdyYXRpb24tdGVzdHMtMTIzNDU2
    expiration-ms: 900000

logging:
  level:
    org.springframework.test.context.cache: INFO
    org.testcontainers: INFO
~~~

Note there is **no** ^spring.datasource.url^: the container's ^@ServiceConnection^ provides the connection details. Property names under ^app.jwt^ must match the ones your Module 4 ^JwtService^ reads (for example via ^@Value("§{app.jwt.secret}")^); adjust if you named them differently.

### Step 3: Web slice test with MockMvc

The controller from Modules 2-3, for reference:

~~~java src/main/java/com/example/bookstore/controller/BookController.java
package com.example.bookstore.controller;

import java.net.URI;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.service.BookService;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/books")
public class BookController {

    private final BookService bookService;

    public BookController(BookService bookService) {
        this.bookService = bookService;
    }

    @GetMapping
    public PageResponse<BookResponse> list(@RequestParam(required = false) String title,
                                           @RequestParam(defaultValue = "0") int page,
                                           @RequestParam(defaultValue = "20") int size) {
        return bookService.findAll(title, page, size);
    }

    @GetMapping("/{id}")
    public BookResponse get(@PathVariable Long id) {
        return bookService.findById(id);
    }

    @PostMapping
    public ResponseEntity<BookResponse> create(@Valid @RequestBody BookRequest request) {
        BookResponse created = bookService.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public BookResponse update(@PathVariable Long id, @Valid @RequestBody BookRequest request) {
        return bookService.update(id, request);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        bookService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
~~~

^@WebMvcTest^ includes ^@Component^ beans that are ^Filter^s and ^SecurityFilterChain^ configuration only when you import them. Our ^SecurityConfig^ needs ^JwtAuthenticationFilter^, which needs ^JwtService^ and ^UserDetailsService^. We import the real ^SecurityConfig^ and the filter (so the real rules are tested) and mock what is behind them.

~~~java src/test/java/com/example/bookstore/controller/BookControllerWebMvcTest.java
package com.example.bookstore.controller;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.hasItem;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.never;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.math.BigDecimal;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.example.bookstore.config.SecurityConfig;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.security.JwtAuthenticationFilter;
import com.example.bookstore.security.JwtService;
import com.example.bookstore.service.BookService;

@WebMvcTest(BookController.class)
@Import({SecurityConfig.class, JwtAuthenticationFilter.class})
class BookControllerWebMvcTest {

    private static final String VALID_BOOK_JSON = """
            {
              "title": "Clean Code",
              "isbn": "9780132350884",
              "price": 39.99,
              "publishedYear": 2008
            }
            """;

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private BookService bookService;

    @MockitoBean
    private JwtService jwtService;

    @MockitoBean
    private UserDetailsService userDetailsService;

    private static BookResponse cleanCode(long id) {
        return new BookResponse(id, "Clean Code", "9780132350884", new BigDecimal("39.99"), 2008);
    }

    @Nested
    @DisplayName("GET /api/books")
    class Reads {

        @Test
        @DisplayName("returns 200 and the book JSON without authentication")
        void getById_returnsBook() throws Exception {
            given(bookService.findById(1L)).willReturn(cleanCode(1L));

            mockMvc.perform(get("/api/books/1").accept(MediaType.APPLICATION_JSON))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.title").value("Clean Code"))
                    .andExpect(jsonPath("$.price").value(39.99));
        }

        @Test
        @DisplayName("returns a 404 ProblemDetail when the book is missing")
        void getById_returns404ProblemDetail() throws Exception {
            given(bookService.findById(99L)).willThrow(new BookNotFoundException(99L));

            mockMvc.perform(get("/api/books/99"))
                    .andExpect(status().isNotFound())
                    .andExpect(header().string("Content-Type", "application/problem+json"))
                    .andExpect(jsonPath("$.status").value(404))
                    .andExpect(jsonPath("$.title").value("Book not found"))
                    .andExpect(jsonPath("$.detail").value(containsString("99")))
                    .andExpect(jsonPath("$.instance").value("/api/books/99"));
        }

        @Test
        @DisplayName("binds paging parameters and returns the page envelope")
        void list_returnsPage() throws Exception {
            given(bookService.findAll(isNull(), anyInt(), anyInt()))
                    .willReturn(new PageResponse<>(List.of(cleanCode(1L)), 0, 1, 3, 3));

            mockMvc.perform(get("/api/books").param("page", "0").param("size", "1"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.content.length()").value(1))
                    .andExpect(jsonPath("$.totalElements").value(3))
                    .andExpect(jsonPath("$.totalPages").value(3));

            then(bookService).should().findAll(null, 0, 1);
        }
    }

    @Nested
    @DisplayName("POST /api/books")
    class Writes {

        @Test
        @DisplayName("401 when not authenticated")
        void create_requiresAuthentication() throws Exception {
            mockMvc.perform(post("/api/books").contentType(MediaType.APPLICATION_JSON).content(VALID_BOOK_JSON))
                    .andExpect(status().isUnauthorized());

            then(bookService).should(never()).create(any());
        }

        @Test
        @WithMockUser(roles = "USER")
        @DisplayName("403 for a user without ADMIN role")
        void create_forbiddenForUser() throws Exception {
            mockMvc.perform(post("/api/books").contentType(MediaType.APPLICATION_JSON).content(VALID_BOOK_JSON))
                    .andExpect(status().isForbidden());
        }

        @Test
        @WithMockUser(roles = "ADMIN")
        @DisplayName("201 with Location header for an admin")
        void create_returns201() throws Exception {
            given(bookService.create(any())).willReturn(cleanCode(10L));

            mockMvc.perform(post("/api/books").contentType(MediaType.APPLICATION_JSON).content(VALID_BOOK_JSON))
                    .andExpect(status().isCreated())
                    .andExpect(header().string("Location", "http://localhost/api/books/10"))
                    .andExpect(jsonPath("$.id").value(10));
        }

        @Test
        @WithMockUser(roles = "ADMIN")
        @DisplayName("400 ProblemDetail listing every invalid field")
        void create_returns400OnValidationErrors() throws Exception {
            String invalid = """
                    { "title": "", "isbn": "123", "price": -1, "publishedYear": 2008 }
                    """;

            mockMvc.perform(post("/api/books").contentType(MediaType.APPLICATION_JSON).content(invalid))
                    .andExpect(status().isBadRequest())
                    .andExpect(header().string("Content-Type", "application/problem+json"))
                    .andExpect(jsonPath("$.status").value(400))
                    .andExpect(jsonPath("$.errors[*].field").value(hasItem("title")))
                    .andExpect(jsonPath("$.errors[*].field").value(hasItem("isbn")))
                    .andExpect(jsonPath("$.errors[*].field").value(hasItem("price")));

            then(bookService).should(never()).create(any());
        }

        @Test
        @WithMockUser(roles = "ADMIN")
        @DisplayName("204 on delete for an admin")
        void delete_returns204() throws Exception {
            mockMvc.perform(delete("/api/books/5"))
                    .andExpect(status().isNoContent());

            then(bookService).should().delete(5L);
        }
    }
}
~~~

**Things to notice:**

- The ^errors[*].field^ assertions assume your 2.3 handler overrides ^handleMethodArgumentNotValid^ and adds an ^errors^ property (a list of objects with ^field^ and ^message^) to the ^ProblemDetail^. If you named it differently, adjust the path: the test is exactly what protects that API contract for your clients.
- ^Content-Type: application/problem+json^ is what Spring sends for a ^ProblemDetail^. Asserting it catches the regression where someone returns a plain ^Map^.
- **401 vs 403** are both tested: unauthenticated is 401 (your ^AuthenticationEntryPoint^ from Module 4), authenticated-but-wrong-role is 403. Swapping them is a common security bug.
- No CSRF token is needed because the ^SecurityConfig^ is stateless and disables CSRF. If your config enabled CSRF, the POSTs would need ^.with(csrf())^.
- ^@WithMockUser^ sets the ^SecurityContext^ directly. Our ^JwtAuthenticationFilter^ sees no ^Authorization^ header and simply continues, so the mock user stays authenticated. This tests the **authorization rules**, not JWT parsing.
- The three ^@MockitoBean^ fields are part of the context cache key. Every ^@WebMvcTest(BookController.class)^ class that mocks the same three beans reuses this context.

### Step 4: A JPA slice on real PostgreSQL with @Testcontainers/@Container

~~~sql src/test/resources/sql/books.sql
DELETE FROM books;

INSERT INTO books (title, isbn, price, published_year) VALUES
  ('Spring in Action', '9781617297571', 49.99, 2022),
  ('Spring Boot Up and Running', '9781098103392', 44.99, 2021),
  ('Clean Code', '9780132350884', 39.99, 2008),
  ('Effective Java', '9780134685991', 45.00, 2018);
~~~

(If ^books^ has foreign keys to ^authors^ or a ^book_categories^ join table from Lesson 3.3, delete from those first.)

~~~java src/test/java/com/example/bookstore/repository/BookRepositoryDataJpaTest.java
package com.example.bookstore.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.jdbc.Sql;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import com.example.bookstore.model.Book;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE) // do NOT swap in H2
@Testcontainers
@ActiveProfiles("test")
@Sql("/sql/books.sql")
class BookRepositoryDataJpaTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @Autowired
    private BookRepository bookRepository;

    @Test
    void findByTitleContainingIgnoreCase_isCaseInsensitiveAndPaged() {
        Page<Book> page = bookRepository.findByTitleContainingIgnoreCase(
                "SPRING", PageRequest.of(0, 1, Sort.by("title")));

        assertThat(page.getTotalElements()).isEqualTo(2);
        assertThat(page.getTotalPages()).isEqualTo(2);
        assertThat(page.getContent()).extracting(Book::getTitle).containsExactly("Spring Boot Up and Running");
    }

    @Test
    void existsByIsbn_findsSeededBook() {
        assertThat(bookRepository.existsByIsbn("9780132350884")).isTrue();
        assertThat(bookRepository.existsByIsbn("0000000000")).isFalse();
    }

    @Test
    void uniqueIsbnConstraint_isEnforcedByPostgres() {
        Book duplicate = new Book("Copy", "9780132350884", new BigDecimal("1.00"), 2020);

        assertThatThrownBy(() -> bookRepository.saveAndFlush(duplicate))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void price_keepsTwoDecimalPlaces() {
        Book saved = bookRepository.saveAndFlush(new Book("Cents", "1234567890", new BigDecimal("9.5"), 2020));

        Book reloaded = bookRepository.findById(saved.getId()).orElseThrow();
        assertThat(reloaded.getPrice()).isEqualByComparingTo("9.50");
    }
}
~~~

**Under the hood:**

- ^@DataJpaTest^ by default **replaces your DataSource with an embedded H2**. ^Replace.NONE^ turns that off. (With a ^@ServiceConnection^ container present, Boot 3.4 already avoids the replacement, but being explicit documents the intent.)
- ^@Testcontainers^ registers the JUnit extension that finds ^@Container^ fields. The field is **static**, so the container starts once before the first test of this class and stops after the last. An instance field would start a new PostgreSQL for every test method.
- ^@ServiceConnection^ on the field makes Boot build ^JdbcConnectionDetails^ from ^postgres.getJdbcUrl()^, username and password.
- Every ^@DataJpaTest^ method runs inside a transaction that is **rolled back** at the end. ^@Sql^ runs inside the same transaction by default, so each test sees exactly the four seeded books and leaves nothing behind. That is why we need no ^@DirtiesContext^.
- ^saveAndFlush^ forces the INSERT now. With plain ^save^, Hibernate might delay the SQL until commit, which never comes (rollback), and the constraint test would pass for the wrong reason or fail mysteriously.
- The unique-constraint test proves the **database** enforces what ^existsByIsbn^ checks in the service: if two requests race, the constraint is the last line of defence. A mocked repository can never tell you that.

### Step 5: A shared container configuration for full tests

~~~java src/test/java/com/example/bookstore/TestcontainersConfiguration.java
package com.example.bookstore;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfiguration {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgresContainer() {
        return new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    }
}
~~~

Spring starts the container when it creates the bean (Boot calls ^start()^ for ^Startable^ beans) and stops it when the context closes. Because contexts are cached, **all** integration tests importing this configuration with the same setup share **one** PostgreSQL and **one** context.

A base class guarantees they really have the same setup (and thus the same cache key):

~~~java src/test/java/com/example/bookstore/AbstractIntegrationTest.java
package com.example.bookstore;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration.class)
@ActiveProfiles("test")
public abstract class AbstractIntegrationTest {
}
~~~

Bonus: the same configuration lets you run the app locally against a throwaway database, which is what Initializr's generated ^TestBookstoreApplication^ does:

~~~java src/test/java/com/example/bookstore/TestBookstoreApplication.java
package com.example.bookstore;

import org.springframework.boot.SpringApplication;

public class TestBookstoreApplication {

    public static void main(String[] args) {
        SpringApplication.from(BookstoreApplication::main)
                .with(TestcontainersConfiguration.class)
                .run(args);
    }
}
~~~

### Step 6: The end-to-end test with a real JWT

This is the "drive around the block" test: real Tomcat on a random port, real security filter chain, real ^JwtService^, real PostgreSQL. We use ^TestRestTemplate^ (auto-configured for ^RANDOM_PORT^ and pointing at the right port) and show ^RestClient^ as the modern alternative.

~~~java src/test/java/com/example/bookstore/BookApiIT.java
package com.example.bookstore;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.test.context.jdbc.Sql;
import org.springframework.web.client.RestClient;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.repository.BookRepository;
import com.example.bookstore.security.JwtService;

@Sql(scripts = "/sql/books.sql")
class BookApiIT extends AbstractIntegrationTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JwtService jwtService;

    @Autowired
    private BookRepository bookRepository;

    @LocalServerPort
    private int port;

    private RestClient restClient;

    @BeforeEach
    void setUp() {
        restClient = RestClient.builder().baseUrl("http://localhost:" + port).build();
    }

    private String adminToken() {
        UserDetails admin = User.withUsername("admin@bookstore.test")
                .password("unused")
                .roles("ADMIN")
                .build();
        return jwtService.generateToken(admin);
    }

    private HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    @Test
    void publicRead_returnsSeededBook() {
        Long id = bookRepository.findByIsbn("9780132350884").orElseThrow().getId();

        ResponseEntity<BookResponse> response = rest.getForEntity("/api/books/" + id, BookResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().title()).isEqualTo("Clean Code");
    }

    @Test
    void missingBook_returnsProblemDetail() {
        ResponseEntity<ProblemDetail> response = rest.getForEntity("/api/books/999999", ProblemDetail.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(response.getHeaders().getContentType().toString()).contains("application/problem+json");
        assertThat(response.getBody().getTitle()).isEqualTo("Book not found");
    }

    @Test
    void createWithoutToken_returns401() {
        BookRequest request = new BookRequest("Domain-Driven Design", "9780321125217", new BigDecimal("59.90"), 2003);

        ResponseEntity<String> response = rest.postForEntity("/api/books", request, String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void createWithTamperedToken_returns401() {
        String token = adminToken();
        String tampered = token.substring(0, token.length() - 2) + "xx";
        BookRequest request = new BookRequest("Tampered", "9780321125217", new BigDecimal("1.00"), 2003);

        ResponseEntity<String> response = rest.exchange("/api/books", HttpMethod.POST,
                new HttpEntity<>(request, bearer(tampered)), String.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void createWithRealAdminJwt_persistsBook() {
        BookRequest request = new BookRequest("Domain-Driven Design", "9780321125217", new BigDecimal("59.90"), 2003);

        ResponseEntity<BookResponse> response = rest.exchange("/api/books", HttpMethod.POST,
                new HttpEntity<>(request, bearer(adminToken())), BookResponse.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getHeaders().getLocation()).isNotNull();
        assertThat(response.getBody().id()).isNotNull();
        assertThat(bookRepository.existsByIsbn("9780321125217")).isTrue(); // really in PostgreSQL
    }

    @Test
    void duplicateIsbn_returns409_viaRestClient() {
        BookRequest duplicate = new BookRequest("Copy", "9780132350884", new BigDecimal("10.00"), 2008);

        ResponseEntity<Map> response = restClient.post()
                .uri("/api/books")
                .headers(h -> h.addAll(bearer(adminToken())))
                .body(duplicate)
                .retrieve()
                .onStatus(status -> true, (req, res) -> { }) // do not throw on 4xx, we assert it
                .toEntity(Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody()).containsEntry("title", "Duplicate ISBN");
    }
}
~~~

**Why this test is valuable:**

- It uses a **real token** from the real ^JwtService^, signed with the test secret. The request passes through the real ^JwtAuthenticationFilter^, which parses and verifies the signature, loads the user and sets the ^SecurityContext^. If the filter, the header parsing or the role prefix ("ROLE_") is wrong, this test fails. (If your filter loads the user from the database via ^UserDetailsService^, insert the admin user in a ^@Sql^ script or call the real ^POST /api/auth/login^ endpoint instead; logging in for real is the most end-to-end option.)
- The tampered-token test proves signatures are actually verified. Teams have shipped filters that decode JWTs without verifying them; this one line of test would have caught it.
- **Data isolation.** Unlike ^@DataJpaTest^, a ^RANDOM_PORT^ test is **not** rolled back: the HTTP request runs on a Tomcat thread, in its own transaction, which commits. Putting ^@Transactional^ on the test would not help (different thread). That is why ^@Sql^ runs ^books.sql^ (which starts with ^DELETE^) **before each test method**, resetting the tables without touching the context.
- No ^@DirtiesContext^: the context and the container are reused by every class extending ^AbstractIntegrationTest^.

### Step 7: Run everything

~~~powershell
# make sure Docker Desktop is running
docker info

# fast feedback: unit + slice tests (*Test), Surefire only
.\mvnw test

# everything including *IT via Failsafe
.\mvnw verify

# a single integration test
.\mvnw verify -Dit.test=BookApiIT -Dtest=NoSuchTest -Dsurefire.failIfNoSpecifiedTests=false
~~~

Expected output (abbreviated):

~~~text
[INFO] --- surefire:3.5.2:test (default-test) @ bookstore ---
[INFO] Running com.example.bookstore.controller.BookControllerWebMvcTest
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 2.143 s
[INFO] Running com.example.bookstore.repository.BookRepositoryDataJpaTest
o.t.DockerClientProviderStrategy : Found Docker environment with local Npipe socket (npipe:////./pipe/docker_engine)
tc.postgres:16-alpine            : Container postgres:16-alpine started in PT2.8S
[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 6.512 s
[INFO] Running com.example.bookstore.service.BookServiceTest
[INFO] Tests run: 13, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.398 s
...
[INFO] --- failsafe:3.5.2:integration-test (default) @ bookstore ---
[INFO] Running com.example.bookstore.BookApiIT
tc.postgres:16-alpine            : Container postgres:16-alpine started in PT2.1S
[INFO] Tests run: 6, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 7.904 s
[INFO] --- failsafe:3.5.2:verify (default) @ bookstore ---
[INFO] BUILD SUCCESS
~~~

If Docker is not running, you will see:

~~~text
java.lang.IllegalStateException: Could not find a valid Docker environment. Please see logs and check configuration
~~~

Start Docker Desktop, wait for "Engine running", and rerun.

### Step 8: Keeping the suite fast

| Technique | Effect |
|---|---|
| Prefer slices over SpringBootTest | Smaller contexts start in about half the time |
| One shared base class for full tests | One context and one container for all IT classes |
| Same MockitoBean set per slice | Context cache hits instead of new contexts |
| Reset data with Sql or rollback, not DirtiesContext | No context restarts |
| Static or bean-scoped containers | One PostgreSQL per class or per context, not per test |
| Use alpine images, pull them once | Smaller downloads, faster start |
| Run test locally, verify before push | Fast inner loop, full safety in CI |

---

## 3. Common Pitfalls & Best Practices

- **Using @SpringBootTest for everything.** Slow suites that nobody runs. Fix: ^@WebMvcTest^ for HTTP contracts, ^@DataJpaTest^ for queries, a few ^@SpringBootTest^ end-to-end tests named ^*IT^.
- **Keeping @MockBean in new code.** It is deprecated since Boot 3.4. Fix: use ^@MockitoBean^ and ^@MockitoSpyBean^ from ^org.springframework.test.context.bean.override.mockito^.
- **Trusting H2 for a PostgreSQL app.** Native queries, constraints and types behave differently. Fix: Testcontainers PostgreSQL with ^@ServiceConnection^ and ^Replace.NONE^ in ^@DataJpaTest^.
- **Sprinkling @DirtiesContext to fix test pollution.** Every use forces a new context. Fix: clean up data with ^@Sql^ or transaction rollback; keep test configurations identical to maximise cache hits.
- **Assuming @Transactional rolls back RANDOM_PORT tests.** The server thread commits its own transaction. Fix: reset data explicitly before each test (^@Sql^ with ^DELETE^ statements or a cleanup helper).
- **Only testing the happy path of security.** Fix: for each protected endpoint test 401 (no or bad token), 403 (wrong role) and the allowed case; include one tampered-token test.
- **Not asserting the error contract.** Clients depend on ^ProblemDetail^ fields. Fix: assert status, ^application/problem+json^, ^title^, ^detail^ and the validation ^errors^ list with jsonPath.
- **Naming slow tests *Test.** They run in every ^.\mvnw test^ and slow the inner loop. Fix: name end-to-end tests ^*IT^ and configure Failsafe.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.`,
exercises:[
{"title":"Exercise 1 (Guided): Extend the web slice and the API test","tasks":["In ^BookControllerWebMvcTest^ add a test for ^PUT /api/books/99^ as ADMIN where ^bookService.update^ throws ^BookNotFoundException^, and assert 404, ^application/problem+json^ and ^$.detail^ containing 99.","Add a test that sends malformed JSON (for example a missing closing brace) as ADMIN and assert a 400 response. Check which exception Spring raises and whether your ^GlobalExceptionHandler^ returns a ^ProblemDetail^ for it.","In ^BookApiIT^ add a test proving that an admin can delete a seeded book with a real JWT (204) and that a subsequent GET returns 404.","Run ^.\\mvnw test^ and then ^.\\mvnw verify^ and note which classes each command executed and how long each took."]},
{"title":"Exercise 2 (Challenge): Authors, categories and context caching","tasks":["Write ^AuthorRepositoryDataJpaTest^ for the Author-Book relationship from Lesson 3.3 on Testcontainers PostgreSQL. Use Hibernate statistics (^spring.jpa.properties.hibernate.generate_statistics=true^ in the test profile) and assert that loading authors with their books via your fetch-join query executes exactly one SQL statement (no N+1).","Create a second IT class that extends ^AbstractIntegrationTest^, set ^logging.level.org.springframework.test.context.cache=DEBUG^, and confirm in the log that the second class reuses the cached context and container.","Now add ^@TestPropertySource(properties = \"app.jwt.expiration-ms=1000\")^ to only that second class and observe the cache miss in the log. Explain why, and move the property somewhere that keeps one cached context.","Use the Spring Boot reference documentation on Testcontainers to replace the ^@Container^ field in ^BookRepositoryDataJpaTest^ with ^@Import(TestcontainersConfiguration.class)^, and compare startup time."]},
{"title":"Exercise 3 (Thinking): Design the test strategy","tasks":["For each of these bugs, name the cheapest test type that would catch it and why: a wrong JPQL query, a missing ^@Valid^ on the controller, a discount calculation off by one, the JWT filter not verifying signatures, ^ddl-auto^ creating a column too short for 13-digit ISBNs.","Find a PostgreSQL behaviour that H2 handles differently (for example ^ILIKE^, ^jsonb^ or the unique-violation SQLState) and write down how a test could be green on H2 but the feature fail in production.","Read the Spring Framework reference section on context caching and list four configuration differences that create a new cache key.","Explain why ^@WithMockUser^ tests do not prove that JWT authentication works, and what the ^BookApiIT^ tests add."]}
]
};
