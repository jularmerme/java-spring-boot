LESSONS['5.1']={
md:String.raw`## 1. Concept & Theory

### Where the project stands

By the end of Module 4 the Bookstore API is a real application: ^Book^, ^Author^ and ^Category^ are JPA entities stored in PostgreSQL, ^BookRepository^ offers derived queries, JPQL and pagination, ^GlobalExceptionHandler^ turns ^BookNotFoundException^ into an RFC 9457 ^ProblemDetail^, and Spring Security protects the endpoints with users, roles and JWTs. What it does not have yet is a safety net. Every change you make right now is verified by hand with curl, which means every change is a gamble.

Module 5 builds that safety net. This lesson covers **unit tests**: fast, isolated tests of a single class (mostly ^BookService^) using **JUnit 5**, **AssertJ** and **Mockito**. Lesson 5.2 covers **integration tests**: controllers, the database and security wired together by Spring.

**New/changed files in this lesson:**

- ^pom.xml^ (changed: JaCoCo plugin; test dependencies come from ^spring-boot-starter-test^)
- ^src/main/java/com/example/bookstore/service/BookService.java^ (changed: injects a ^Clock^, validates the published year)
- ^src/main/java/com/example/bookstore/config/ClockConfig.java^ (new)
- ^src/main/java/com/example/bookstore/exception/InvalidBookException.java^ (new)
- ^src/main/java/com/example/bookstore/exception/DuplicateIsbnException.java^ (new)
- ^src/test/java/com/example/bookstore/testdata/BookTestData.java^ (new: test data builder)
- ^src/test/java/com/example/bookstore/service/BookServiceTest.java^ (new)
- ^src/test/java/com/example/bookstore/service/BookServiceBddTest.java^ (new)
- ^src/test/java/com/example/bookstore/service/PriceCalculatorTest.java^ (new: parameterized tests)

### Why automated tests exist (the production view)

Imagine a bridge inspector who re-checks every bolt by hand each time a single bolt is replaced. That is manual testing. Now imagine sensors on every bolt that report in seconds. That is an automated test suite. The sensors do not make the bridge stronger by themselves; they make it **safe to change** the bridge.

In production teams, tests buy three things:

- **Confidence to refactor.** You can rename, split and restructure code and know within seconds whether behaviour changed.
- **Executable documentation.** A test named ^findById_throwsBookNotFound_whenIdDoesNotExist^ documents a business rule more reliably than a wiki page, because it fails when the rule changes.
- **Cheaper bugs.** A bug caught by a unit test on your laptop costs minutes. The same bug caught in production costs an incident, a rollback, a post-mortem and maybe customer trust.

### The testing pyramid

The testing pyramid (Mike Cohn) describes the healthy shape of a test suite: many small fast tests at the bottom, fewer slow broad tests at the top.

| Layer | What it tests | Speed | Count in a typical service | Bookstore example |
|---|---|---|---|---|
| Unit | One class, collaborators replaced by mocks or fakes | Milliseconds | Hundreds to thousands | BookService with a mocked BookRepository |
| Slice / Integration | A few real components wired by Spring | 100 ms to seconds | Dozens to hundreds | WebMvcTest of BookController, DataJpaTest of BookRepository |
| End-to-end | Whole app over HTTP with a real DB | Seconds | A handful | SpringBootTest with RANDOM_PORT and Testcontainers |

The anti-pattern is the **ice-cream cone**: almost everything is tested through the UI or full HTTP stack, the suite takes 40 minutes, it is flaky, and developers stop running it. The pyramid keeps feedback fast: the unit tests run on every save, the slower tests run before you push and in CI.

### What exactly is a unit test?

A unit test checks **one unit of behaviour** in **isolation**, quickly and deterministically. Four properties matter:

| Property | Meaning | What breaks it |
|---|---|---|
| Fast | Runs in milliseconds, so you can run hundreds on every save | Starting a Spring context, hitting a DB, sleeping |
| Isolated | Only the class under test is real; collaborators are controlled | Real repositories, network calls, shared static state |
| Deterministic | Same result every time, on every machine | LocalDate.now(), random numbers, test order dependencies |
| Self-validating | Passes or fails on its own, no human reading logs | Tests that print output instead of asserting |

**Why isolation?** If ^BookServiceTest^ uses a real PostgreSQL, a failing test could mean a bug in ^BookService^, a broken SQL query, a missing table, a Docker problem or a network glitch. Isolation makes a failure point at exactly one class. It also makes the test fast, and it lets you simulate situations that are hard to produce for real ("the repository says this ISBN already exists", "the database throws").

Note that a "unit" is a unit of **behaviour**, not necessarily a single method. Testing "creating a book with a duplicate ISBN is rejected" is a good unit test even though it touches two repository calls.

### JUnit 5 under the hood

JUnit 5 is three projects:

- **JUnit Platform**: the launcher that IDEs and Maven Surefire talk to. It discovers and runs tests from any engine.
- **JUnit Jupiter**: the programming model you write against (^@Test^, ^@BeforeEach^, ^@Nested^, extensions). Package ^org.junit.jupiter.api^.
- **JUnit Vintage**: an engine that runs old JUnit 4 tests. Spring Boot does not include it any more; you will not need it.

When you run ^.\mvnw test^, Maven Surefire starts the JUnit Platform, which asks the Jupiter engine to scan ^target/test-classes^ for classes with test methods. For **each test method, Jupiter creates a brand-new instance of the test class** (the default "per-method" lifecycle). That is why fields set in ^@BeforeEach^ never leak between tests, and why you should not rely on test order.

The core annotations:

| Annotation | Purpose |
|---|---|
| @Test | Marks a test method (no public modifier needed in JUnit 5) |
| @DisplayName | Human-readable name in reports and the IDE |
| @BeforeEach / @AfterEach | Runs before/after every test method |
| @BeforeAll / @AfterAll | Runs once per class (static methods by default) |
| @Nested | Inner non-static class grouping related tests, with its own BeforeEach |
| @ParameterizedTest | Same test, many inputs |
| @CsvSource / @ValueSource / @MethodSource | Supplies the inputs for a parameterized test |
| @Disabled | Skips a test (always write the reason) |
| @ExtendWith | Plugs in an extension, e.g. MockitoExtension or SpringExtension |

**Extensions** are the Jupiter plug-in mechanism. ^@ExtendWith(MockitoExtension.class)^ registers a callback that runs before each test, scans the test instance for ^@Mock^ and ^@InjectMocks^ fields, creates the mocks, and after the test validates strict stubbing. Spring's ^@SpringBootTest^ uses the same mechanism with ^SpringExtension^.

### AssertJ: assertions that read like sentences

JUnit has its own ^Assertions.assertEquals^, but Spring Boot's ^spring-boot-starter-test^ ships **AssertJ**, and production teams overwhelmingly prefer it:

~~~java
// JUnit style: which one is expected and which is actual? Easy to swap.
assertEquals("Clean Code", response.title());

// AssertJ style: fluent, discoverable with IDE autocomplete, better failure messages
assertThat(response.title()).isEqualTo("Clean Code");
assertThat(page.content()).hasSize(2).extracting(BookResponse::title).containsExactly("A", "B");
assertThat(response.price()).isEqualByComparingTo("39.99");
~~~

That last line matters for money: ^new BigDecimal("39.99").equals(new BigDecimal("39.990"))^ is **false** because ^equals^ compares scale. ^isEqualByComparingTo^ uses ^compareTo^, which is what you mean.

For exceptions you have two options:

~~~java
// JUnit: returns the exception so you can inspect it
BookNotFoundException ex = assertThrows(BookNotFoundException.class, () -> bookService.findById(99L));
assertThat(ex.getMessage()).contains("99");

// AssertJ: one fluent chain
assertThatThrownBy(() -> bookService.findById(99L))
        .isInstanceOf(BookNotFoundException.class)
        .hasMessageContaining("99");
~~~

### Mockito: test doubles on demand

A **test double** is anything that stands in for a real collaborator (like a stunt double for an actor). Gerard Meszaros named the kinds:

| Double | What it does | Bookstore example |
|---|---|---|
| Dummy | Passed in, never used | A null Clock in a test that never reads time |
| Stub | Returns canned answers | bookRepository.findById(1L) returns a book |
| Mock | Stub plus verification of interactions | verify(bookRepository).deleteById(1L) |
| Spy | Wraps a REAL object, records calls, can override some methods | spy(new PriceCalculator()) |
| Fake | Working, simplified implementation | An in-memory BookRepository backed by a HashMap |

**How Mockito works under the hood.** When you write ^@Mock BookRepository bookRepository^, Mockito uses **ByteBuddy** to generate a subclass (or, with the default inline mock maker since Mockito 5, instruments the bytecode of the type) at runtime. Every method of that generated class is intercepted: instead of running real code it asks Mockito's internal registry "has anyone stubbed this method with these arguments?". If yes, it returns the stubbed answer; if no, it returns a sensible default (^null^ for objects, ^0^ for numbers, ^false^, ^Optional.empty()^ for ^Optional^, empty collections for ^List^). Every invocation is also **recorded**, which is what ^verify^ later inspects.

^when(bookRepository.findById(1L)).thenReturn(Optional.of(book))^ looks like magic, but it is just: (1) call the mock, which records "last invocation = findById(1L)" and returns a default; (2) ^when(...)^ grabs that last invocation; (3) ^thenReturn^ registers the answer for it.

The key Mockito tools you will use:

| Tool | Use |
|---|---|
| @Mock | Create a mock for a field |
| @InjectMocks | Create the class under test and inject the mocks (constructor injection first) |
| when(...).thenReturn(...) | Stub a return value |
| when(...).thenThrow(...) | Stub an exception |
| verify(mock).method(args) | Assert an interaction happened |
| verify(mock, never()).save(any()) | Assert it did NOT happen |
| verifyNoMoreInteractions(mock) | Assert nothing else was called (use sparingly) |
| ArgumentCaptor | Capture the argument passed to a mock so you can assert on it |
| any(), eq(), argThat(...) | Argument matchers |
| BDDMockito given/then | Same features with Given-When-Then wording |

### Strict stubs

^MockitoExtension^ uses **strict stubs** by default. If you stub something the test never uses, the test fails with ^UnnecessaryStubbingException^. That feels annoying at first, but it is a production-grade feature: unused stubs are dead code that misleads the next reader ("why do we stub ^existsByIsbn^ in the delete test?"), and they often hide a bug where the code took a different path than you assumed. Strictness also reports **argument mismatches** (you stubbed ^findById(1L)^ but the code called ^findById(2L)^) with a clear ^PotentialStubbingProblem^ instead of a confusing null. If one specific stub is genuinely shared and optional, mark only that one with ^lenient().when(...)^; never turn strictness off globally.

### Mock vs spy vs fake: choosing the right double

- **Mock** when the collaborator is an interface at a boundary (repository, HTTP client, message publisher) and you care about what is returned or what was called.
- **Spy** almost never. If you need to partially mock a class, that class usually does too much. Spies are acceptable for legacy code you cannot change yet.
- **Fake** when many tests need realistic behaviour from a collaborator, e.g. an in-memory repository that really stores and finds books. Fakes make tests less brittle because they do not encode "which method was called", only results.

### What NOT to mock

Over-mocking is the most common unit-testing failure in Spring codebases. Do not mock:

- **Value objects and DTOs** (^BookRequest^, ^BookResponse^, ^BigDecimal^, ^LocalDate^): just create them.
- **Your own simple, pure logic classes** (a ^PriceCalculator^ with no dependencies): use the real one.
- **Types you do not own with complex behaviour**, such as ^EntityManager^, ^RestClient^ fluent chains or ^JdbcTemplate^. Mocking them encodes your assumptions about how they behave, and those assumptions are exactly what breaks. Test those with integration tests (Lesson 5.2).
- **The class under test itself.**
- **Static time** (^LocalDate.now()^): do not reach for ^mockStatic^, inject a ^Clock^ instead.

A good rule: **mock roles at the boundary of your class, not the internals of a library.**

### Arrange-Act-Assert and naming

Every test should have three visible parts, separated by a blank line:

1. **Arrange** (Given): build inputs and stub collaborators.
1. **Act** (When): call exactly one method on the class under test.
1. **Assert** (Then): check the result and, if relevant, interactions.

For names, pick one convention and keep it. Two popular ones:

| Convention | Example |
|---|---|
| method_expectedResult_whenCondition | findById_throwsBookNotFound_whenIdDoesNotExist |
| should...when... with DisplayName | shouldThrowBookNotFoundWhenIdDoesNotExist + DisplayName "throws 404 exception when book is missing" |

A test name should still make sense in a CI report read by someone who has never seen the code.

### Time: why we inject a Clock (callback to Lesson 1.1)

In Lesson 1.1 you learned that Spring creates beans and injects them through constructors, and that this is what makes code testable. Here is the payoff. ^BookService^ must reject a ^publishedYear^ in the future. If the service calls ^Year.now()^ directly, a test written today passes until New Year and then a "future" year becomes the present and the test starts failing. Hidden dependencies on the system clock are a classic source of flaky tests.

The fix: treat time as a **dependency**. Register a ^java.time.Clock^ bean (^Clock.systemUTC()^) in production and inject it into the service. In tests, pass ^Clock.fixed(Instant.parse("2026-06-15T10:00:00Z"), ZoneOffset.UTC)^. Now "today" is whatever the test says, forever.

### Coverage with JaCoCo, and why percent is not quality

**JaCoCo** (Java Code Coverage) attaches a Java agent to the test JVM, instruments the bytecode as classes load, and records which lines and branches executed. After the tests, it writes ^target/jacoco.exec^ and produces an HTML report.

| Metric | Meaning |
|---|---|
| Line coverage | Fraction of executable lines that ran |
| Branch coverage | Fraction of if/else and switch branches taken (more meaningful) |
| Instruction coverage | Bytecode instructions executed |

Coverage tells you what code was **executed**, not what was **verified**. A test that calls every method and asserts nothing reaches 100% coverage and catches zero bugs. Use coverage to find **untested areas** (that red ^else^ branch for a duplicate ISBN), not as a target to game. Many teams set a sensible floor (e.g. 70-80% on the service layer) with JaCoCo's ^check^ goal and rely on code review for test quality. Mutation testing (PIT) is the tool that actually measures whether tests catch changes; it is a good next step to read about.

### Test data builders

Tests need objects. Calling a five-argument constructor in every test is noisy, and when ^Book^ gains a sixth field, 80 tests break. A **test data builder** gives every field a valid default and lets each test override only what it cares about:

~~~java
Book book = BookTestData.aBook().withId(1L).withPrice("9.99").build();
~~~

The test now shouts the one thing that matters (the price) and hides the irrelevant rest. That is the single biggest readability improvement you can make to a test suite.

---

## 2. Code Walkthrough

### Step 1: Test dependencies and JaCoCo

^spring-boot-starter-test^ (added by Spring Initializr in 2.1) already includes JUnit Jupiter, AssertJ, Mockito (with ^mockito-junit-jupiter^), Hamcrest, JSONassert, JsonPath and Spring Test. You add only the JaCoCo plugin. Shown here is the relevant part of the pom; keep your existing dependencies.

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
    <artifactId>bookstore</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>bookstore</name>

    <properties>
        <java.version>21</java.version>
    </properties>

    <dependencies>
        <!-- existing: web, validation, actuator, data-jpa, postgresql, h2, security, jjwt, devtools ... -->

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
    </dependencies>

    <build>
        <plugins>
            <plugin>
                <groupId>org.springframework.boot</groupId>
                <artifactId>spring-boot-maven-plugin</artifactId>
            </plugin>
            <plugin>
                <groupId>org.jacoco</groupId>
                <artifactId>jacoco-maven-plugin</artifactId>
                <version>0.8.12</version>
                <executions>
                    <execution>
                        <id>prepare-agent</id>
                        <goals>
                            <goal>prepare-agent</goal>
                        </goals>
                    </execution>
                    <execution>
                        <id>report</id>
                        <phase>test</phase>
                        <goals>
                            <goal>report</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
~~~

^prepare-agent^ sets the ^argLine^ property so Surefire starts the test JVM with the JaCoCo agent; ^report^ runs after tests and writes ^target/site/jacoco/index.html^.

### Step 2: A Clock bean

~~~java src/main/java/com/example/bookstore/config/ClockConfig.java
package com.example.bookstore.config;

import java.time.Clock;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class ClockConfig {

    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
~~~

### Step 3: Two new exceptions

~~~java src/main/java/com/example/bookstore/exception/InvalidBookException.java
package com.example.bookstore.exception;

public class InvalidBookException extends RuntimeException {

    public InvalidBookException(String message) {
        super(message);
    }
}
~~~

~~~java src/main/java/com/example/bookstore/exception/DuplicateIsbnException.java
package com.example.bookstore.exception;

public class DuplicateIsbnException extends RuntimeException {

    public DuplicateIsbnException(String isbn) {
        super("A book with ISBN " + isbn + " already exists");
    }
}
~~~

Add handlers to your existing ^GlobalExceptionHandler^ from 2.3 mapping ^InvalidBookException^ to 400 and ^DuplicateIsbnException^ to 409 Conflict, in the same ^ProblemDetail^ style as ^BookNotFoundException^:

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
package com.example.bookstore.exception;

import java.net.URI;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(BookNotFoundException.class)
    public ProblemDetail handleNotFound(BookNotFoundException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Book not found");
        pd.setType(URI.create("https://bookstore.example.com/problems/book-not-found"));
        return pd;
    }

    @ExceptionHandler(InvalidBookException.class)
    public ProblemDetail handleInvalid(InvalidBookException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
        pd.setTitle("Invalid book");
        pd.setType(URI.create("https://bookstore.example.com/problems/invalid-book"));
        return pd;
    }

    @ExceptionHandler(DuplicateIsbnException.class)
    public ProblemDetail handleDuplicate(DuplicateIsbnException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, ex.getMessage());
        pd.setTitle("Duplicate ISBN");
        pd.setType(URI.create("https://bookstore.example.com/problems/duplicate-isbn"));
        return pd;
    }
}
~~~

### Step 4: The service under test

This is the ^BookService^ from Module 3, now with an injected ^Clock^, a publication-year rule and a duplicate-ISBN rule. For the unit tests we keep it focused on books (author/category handling from 3.3 stays as you wrote it; it is omitted here so the testing ideas stay clear). Pagination returns a small ^PageResponse^ record so the API does not leak Spring's ^Page^ JSON format.

~~~java src/main/java/com/example/bookstore/dto/BookRequest.java
package com.example.bookstore.dto;

import java.math.BigDecimal;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record BookRequest(
        @NotBlank @Size(max = 200) String title,
        @NotBlank @Pattern(regexp = "\\d{10}|\\d{13}", message = "must be 10 or 13 digits") String isbn,
        @NotNull @DecimalMin(value = "0.00", inclusive = true) BigDecimal price,
        int publishedYear) {
}
~~~

~~~java src/main/java/com/example/bookstore/dto/BookResponse.java
package com.example.bookstore.dto;

import java.math.BigDecimal;

import com.example.bookstore.model.Book;

public record BookResponse(Long id, String title, String isbn, BigDecimal price, int publishedYear) {

    public static BookResponse from(Book book) {
        return new BookResponse(book.getId(), book.getTitle(), book.getIsbn(),
                book.getPrice(), book.getPublishedYear());
    }
}
~~~

~~~java src/main/java/com/example/bookstore/dto/PageResponse.java
package com.example.bookstore.dto;

import java.util.List;

import org.springframework.data.domain.Page;

public record PageResponse<T>(List<T> content, int page, int size, long totalElements, int totalPages) {

    public static <T> PageResponse<T> from(Page<T> page) {
        return new PageResponse<>(page.getContent(), page.getNumber(), page.getSize(),
                page.getTotalElements(), page.getTotalPages());
    }
}
~~~

~~~java src/main/java/com/example/bookstore/repository/BookRepository.java
package com.example.bookstore.repository;

import java.util.Optional;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import com.example.bookstore.model.Book;

public interface BookRepository extends JpaRepository<Book, Long> {

    Optional<Book> findByIsbn(String isbn);

    boolean existsByIsbn(String isbn);

    Page<Book> findByTitleContainingIgnoreCase(String title, Pageable pageable);
}
~~~

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import java.time.Clock;
import java.time.Year;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.exception.InvalidBookException;
import com.example.bookstore.model.Book;
import com.example.bookstore.repository.BookRepository;

@Service
@Transactional(readOnly = true)
public class BookService {

    static final int MAX_PAGE_SIZE = 100;

    private final BookRepository bookRepository;
    private final Clock clock;

    public BookService(BookRepository bookRepository, Clock clock) {
        this.bookRepository = bookRepository;
        this.clock = clock;
    }

    public BookResponse findById(Long id) {
        return bookRepository.findById(id)
                .map(BookResponse::from)
                .orElseThrow(() -> new BookNotFoundException(id));
    }

    public PageResponse<BookResponse> findAll(String titleFilter, int page, int size) {
        int safeSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
        Pageable pageable = PageRequest.of(Math.max(page, 0), safeSize, Sort.by("title").ascending());
        Page<Book> books = (titleFilter == null || titleFilter.isBlank())
                ? bookRepository.findAll(pageable)
                : bookRepository.findByTitleContainingIgnoreCase(titleFilter.trim(), pageable);
        return PageResponse.from(books.map(BookResponse::from));
    }

    @Transactional
    public BookResponse create(BookRequest request) {
        validatePublishedYear(request.publishedYear());
        if (bookRepository.existsByIsbn(request.isbn())) {
            throw new DuplicateIsbnException(request.isbn());
        }
        Book book = new Book(request.title(), request.isbn(), request.price(), request.publishedYear());
        return BookResponse.from(bookRepository.save(book));
    }

    @Transactional
    public BookResponse update(Long id, BookRequest request) {
        validatePublishedYear(request.publishedYear());
        Book book = bookRepository.findById(id).orElseThrow(() -> new BookNotFoundException(id));
        book.setTitle(request.title());
        book.setIsbn(request.isbn());
        book.setPrice(request.price());
        book.setPublishedYear(request.publishedYear());
        return BookResponse.from(book); // dirty checking flushes the change at commit
    }

    @Transactional
    public void delete(Long id) {
        if (!bookRepository.existsById(id)) {
            throw new BookNotFoundException(id);
        }
        bookRepository.deleteById(id);
    }

    private void validatePublishedYear(int publishedYear) {
        int currentYear = Year.now(clock).getValue();
        if (publishedYear < 1450 || publishedYear > currentYear) {
            throw new InvalidBookException(
                    "publishedYear must be between 1450 and " + currentYear + " but was " + publishedYear);
        }
    }
}
~~~

Note ^Year.now(clock)^: the service never asks the operating system for the time, it asks the injected clock. In production that is ^Clock.systemUTC()^; in tests it is whatever we decide. Also note the ^update^ method does not call ^save^: inside a transaction, Hibernate's dirty checking writes the change at commit (Lesson 3.3). A unit test cannot verify that flush happens, which is a hint that some behaviour belongs in an integration test.

For reference, the ^Book^ entity from 3.1 (constructor used above):

~~~java src/main/java/com/example/bookstore/model/Book.java
package com.example.bookstore.model;

import java.math.BigDecimal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "books")
public class Book {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(nullable = false, unique = true, length = 13)
    private String isbn;

    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    @Column(name = "published_year", nullable = false)
    private int publishedYear;

    protected Book() {
        // required by JPA
    }

    public Book(String title, String isbn, BigDecimal price, int publishedYear) {
        this.title = title;
        this.isbn = isbn;
        this.price = price;
        this.publishedYear = publishedYear;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getIsbn() { return isbn; }
    public void setIsbn(String isbn) { this.isbn = isbn; }
    public BigDecimal getPrice() { return price; }
    public void setPrice(BigDecimal price) { this.price = price; }
    public int getPublishedYear() { return publishedYear; }
    public void setPublishedYear(int publishedYear) { this.publishedYear = publishedYear; }
}
~~~

(If your 3.3 version also has ^author^ and ^categories^ fields, keep them; the tests below do not touch them.)

### Step 5: A test data builder

~~~java src/test/java/com/example/bookstore/testdata/BookTestData.java
package com.example.bookstore.testdata;

import java.math.BigDecimal;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.model.Book;

public final class BookTestData {

    private Long id = null;
    private String title = "Clean Code";
    private String isbn = "9780132350884";
    private BigDecimal price = new BigDecimal("39.99");
    private int publishedYear = 2008;

    private BookTestData() {
    }

    public static BookTestData aBook() {
        return new BookTestData();
    }

    public BookTestData withId(Long id) { this.id = id; return this; }
    public BookTestData withTitle(String title) { this.title = title; return this; }
    public BookTestData withIsbn(String isbn) { this.isbn = isbn; return this; }
    public BookTestData withPrice(String price) { this.price = new BigDecimal(price); return this; }
    public BookTestData withPublishedYear(int year) { this.publishedYear = year; return this; }

    public Book build() {
        Book book = new Book(title, isbn, price, publishedYear);
        book.setId(id);
        return book;
    }

    public BookRequest buildRequest() {
        return new BookRequest(title, isbn, price, publishedYear);
    }
}
~~~

One builder, two outputs: the entity (what the repository returns) and the request DTO (what the controller passes in). Both start from the same valid defaults.

### Step 6: The main unit test with Mockito

~~~java src/test/java/com/example/bookstore/service/BookServiceTest.java
package com.example.bookstore.service;

import static com.example.bookstore.testdata.BookTestData.aBook;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Captor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.exception.InvalidBookException;
import com.example.bookstore.model.Book;
import com.example.bookstore.repository.BookRepository;

@ExtendWith(MockitoExtension.class)
@DisplayName("BookService")
class BookServiceTest {

    // "Today" is 15 June 2026, forever, on every machine.
    private static final Clock FIXED_CLOCK =
            Clock.fixed(Instant.parse("2026-06-15T10:00:00Z"), ZoneOffset.UTC);

    @Mock
    private BookRepository bookRepository;

    @Captor
    private ArgumentCaptor<Book> bookCaptor;

    @Captor
    private ArgumentCaptor<Pageable> pageableCaptor;

    private BookService bookService;

    @BeforeEach
    void setUp() {
        // Built by hand: Clock is a value, not a mock. @InjectMocks would need a Clock mock instead.
        bookService = new BookService(bookRepository, FIXED_CLOCK);
    }

    @Nested
    @DisplayName("findById")
    class FindById {

        @Test
        @DisplayName("returns the mapped book when it exists")
        void findById_returnsBook_whenExists() {
            // Arrange
            Book book = aBook().withId(1L).withTitle("Refactoring").build();
            when(bookRepository.findById(1L)).thenReturn(Optional.of(book));

            // Act
            BookResponse response = bookService.findById(1L);

            // Assert
            assertThat(response.id()).isEqualTo(1L);
            assertThat(response.title()).isEqualTo("Refactoring");
            assertThat(response.price()).isEqualByComparingTo("39.99");
        }

        @Test
        @DisplayName("throws BookNotFoundException when the id does not exist")
        void findById_throwsBookNotFound_whenMissing() {
            when(bookRepository.findById(99L)).thenReturn(Optional.empty());

            BookNotFoundException ex =
                    assertThrows(BookNotFoundException.class, () -> bookService.findById(99L));

            assertThat(ex.getMessage()).contains("99");
        }

        @Test
        @DisplayName("propagates repository failures unchanged")
        void findById_propagatesDatabaseFailure() {
            when(bookRepository.findById(1L))
                    .thenThrow(new DataAccessResourceFailureException("connection refused"));

            assertThatThrownBy(() -> bookService.findById(1L))
                    .isInstanceOf(DataAccessResourceFailureException.class)
                    .hasMessageContaining("connection refused");
        }
    }

    @Nested
    @DisplayName("findAll (pagination)")
    class FindAll {

        @Test
        @DisplayName("builds a title-sorted Pageable and maps the page")
        void findAll_returnsMappedPage() {
            List<Book> books = List.of(
                    aBook().withId(1L).withTitle("A Book").withIsbn("1111111111").build(),
                    aBook().withId(2L).withTitle("B Book").withIsbn("2222222222").build());
            Page<Book> page = new PageImpl<>(books, Pageable.ofSize(2).withPage(1), 7);
            when(bookRepository.findAll(any(Pageable.class))).thenReturn(page);

            PageResponse<BookResponse> result = bookService.findAll(null, 1, 2);

            verify(bookRepository).findAll(pageableCaptor.capture());
            Pageable used = pageableCaptor.getValue();
            assertThat(used.getPageNumber()).isEqualTo(1);
            assertThat(used.getPageSize()).isEqualTo(2);
            assertThat(used.getSort()).isEqualTo(Sort.by("title").ascending());

            assertThat(result.content()).extracting(BookResponse::title).containsExactly("A Book", "B Book");
            assertThat(result.totalElements()).isEqualTo(7);
            assertThat(result.totalPages()).isEqualTo(4);
            assertThat(result.page()).isEqualTo(1);
        }

        @Test
        @DisplayName("caps the page size at MAX_PAGE_SIZE")
        void findAll_capsPageSize() {
            when(bookRepository.findAll(any(Pageable.class))).thenReturn(Page.empty());

            bookService.findAll(null, 0, 10_000);

            verify(bookRepository).findAll(pageableCaptor.capture());
            assertThat(pageableCaptor.getValue().getPageSize()).isEqualTo(BookService.MAX_PAGE_SIZE);
        }

        @Test
        @DisplayName("uses the title search when a filter is given")
        void findAll_usesTitleSearch_whenFilterPresent() {
            when(bookRepository.findByTitleContainingIgnoreCase(any(String.class), any(Pageable.class)))
                    .thenReturn(Page.empty());

            bookService.findAll("  spring  ", 0, 20);

            verify(bookRepository).findByTitleContainingIgnoreCase(org.mockito.ArgumentMatchers.eq("spring"),
                    any(Pageable.class));
            verify(bookRepository, never()).findAll(any(Pageable.class));
        }
    }

    @Nested
    @DisplayName("create")
    class Create {

        @Test
        @DisplayName("saves a new book built from the request")
        void create_savesBook() {
            BookRequest request = aBook().withTitle("Effective Java").withIsbn("9780134685991").buildRequest();
            when(bookRepository.existsByIsbn("9780134685991")).thenReturn(false);
            when(bookRepository.save(any(Book.class))).thenAnswer(invocation -> {
                Book toSave = invocation.getArgument(0);
                toSave.setId(42L); // simulate the database generating the id
                return toSave;
            });

            BookResponse response = bookService.create(request);

            verify(bookRepository).save(bookCaptor.capture());
            Book saved = bookCaptor.getValue();
            assertThat(saved.getTitle()).isEqualTo("Effective Java");
            assertThat(saved.getIsbn()).isEqualTo("9780134685991");
            assertThat(response.id()).isEqualTo(42L);
        }

        @Test
        @DisplayName("rejects a duplicate ISBN and never saves")
        void create_throwsDuplicateIsbn_whenIsbnExists() {
            BookRequest request = aBook().buildRequest();
            when(bookRepository.existsByIsbn(request.isbn())).thenReturn(true);

            assertThatThrownBy(() -> bookService.create(request))
                    .isInstanceOf(DuplicateIsbnException.class)
                    .hasMessageContaining(request.isbn());

            verify(bookRepository, never()).save(any());
        }

        @Test
        @DisplayName("accepts a book published in the current year (2026 per fixed clock)")
        void create_acceptsCurrentYear() {
            BookRequest request = aBook().withPublishedYear(2026).buildRequest();
            when(bookRepository.existsByIsbn(anyString())).thenReturn(false);
            when(bookRepository.save(any(Book.class))).thenAnswer(inv -> inv.getArgument(0));

            BookResponse response = bookService.create(request);

            assertThat(response.publishedYear()).isEqualTo(2026);
        }

        @Test
        @DisplayName("rejects a publication year in the future without touching the repository")
        void create_rejectsFutureYear() {
            BookRequest request = aBook().withPublishedYear(2027).buildRequest();

            assertThatThrownBy(() -> bookService.create(request))
                    .isInstanceOf(InvalidBookException.class)
                    .hasMessageContaining("2026")
                    .hasMessageContaining("2027");

            verifyNoInteractions(bookRepository);
        }
    }

    @Nested
    @DisplayName("update and delete")
    class UpdateAndDelete {

        @Test
        @DisplayName("update changes the managed entity's fields")
        void update_changesFields() {
            Book existing = aBook().withId(5L).withPrice("10.00").build();
            when(bookRepository.findById(5L)).thenReturn(Optional.of(existing));
            BookRequest request = aBook().withTitle("Clean Code 2nd Ed").withPrice("44.50").buildRequest();

            BookResponse response = bookService.update(5L, request);

            assertThat(existing.getTitle()).isEqualTo("Clean Code 2nd Ed");
            assertThat(existing.getPrice()).isEqualByComparingTo("44.50");
            assertThat(response.id()).isEqualTo(5L);
        }

        @Test
        @DisplayName("delete throws BookNotFoundException and does not delete when missing")
        void delete_throwsWhenMissing() {
            when(bookRepository.existsById(7L)).thenReturn(false);

            assertThatThrownBy(() -> bookService.delete(7L)).isInstanceOf(BookNotFoundException.class);

            verify(bookRepository, never()).deleteById(any());
        }

        @Test
        @DisplayName("delete removes an existing book")
        void delete_removesExisting() {
            when(bookRepository.existsById(7L)).thenReturn(true);

            bookService.delete(7L);

            verify(bookRepository).deleteById(7L);
        }
    }
}
~~~

**What to notice:**

- ^@ExtendWith(MockitoExtension.class)^ creates the ^@Mock^ and the ^@Captor^ fields before each test and checks strict stubs after it. No Spring context starts: this whole class runs in well under a second.
- We build ^BookService^ by hand in ^@BeforeEach^ instead of using ^@InjectMocks^, because one dependency (the ^Clock^) is a real value. When **all** constructor dependencies are mocks, ^@InjectMocks^ is fine and shorter: ^@InjectMocks private BookService bookService;^ uses constructor injection, the same way Spring does.
- ^@Nested^ classes group tests by method. The IDE shows a tree: BookService, then findById, then each case. Each nested class shares the outer ^setUp^.
- The **not-found path** is covered three ways: ^findById^ with an empty ^Optional^, ^delete^ with ^existsById^ false, and (implicitly) ^update^, which you will add as an exercise.
- The **pagination path** uses an ^ArgumentCaptor<Pageable>^ to check the service built the right request (page, size, sort) and checks the mapping of ^totalElements^ and ^totalPages^. ^PageImpl^ calculates ^totalPages^ from the total (7) and page size (2): 4.
- ^thenAnswer^ simulates the database assigning an id. That keeps the test honest: the service returns whatever ^save^ returned, not the object it passed in.
- ^verifyNoInteractions(bookRepository)^ proves validation happens **before** any database work, which is a real performance and correctness property.
- The year tests only work because the clock is fixed. With ^Year.now()^ the 2026 test would break on 1 January 2027.

### Step 7: The same style with BDDMockito

Many teams write tests in Given-When-Then language. BDDMockito is an alias layer over Mockito: ^given^ instead of ^when^, ^then(mock).should()^ instead of ^verify^. Pick one style per codebase.

~~~java src/test/java/com/example/bookstore/service/BookServiceBddTest.java
package com.example.bookstore.service;

import static com.example.bookstore.testdata.BookTestData.aBook;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.mockito.BDDMockito.then;
import static org.mockito.Mockito.never;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.repository.BookRepository;

@ExtendWith(MockitoExtension.class)
class BookServiceBddTest {

    @Mock
    private BookRepository bookRepository;

    private BookService bookService;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-06-15T10:00:00Z"), ZoneOffset.UTC);
        bookService = new BookService(bookRepository, clock);
    }

    @Test
    @DisplayName("given an unknown id, when updating, then BookNotFoundException is thrown")
    void updateUnknownBook() {
        // given
        given(bookRepository.findById(123L)).willReturn(Optional.empty());
        BookRequest request = aBook().buildRequest();

        // when
        Throwable thrown = catchThrowable(() -> bookService.update(123L, request));

        // then
        assertThat(thrown).isInstanceOf(BookNotFoundException.class).hasMessageContaining("123");
    }

    @Test
    @DisplayName("given an existing ISBN, when creating, then it is rejected and nothing is saved")
    void createDuplicate() {
        // given
        BookRequest request = aBook().buildRequest();
        given(bookRepository.existsByIsbn(request.isbn())).willReturn(true);

        // when
        Throwable thrown = catchThrowable(() -> bookService.create(request));

        // then
        assertThat(thrown).isInstanceOf(DuplicateIsbnException.class);
        then(bookRepository).should(never()).save(any());
    }
}
~~~

### Step 8: Parameterized tests for pure logic (no mocks at all)

Some logic deserves its own small class. Imagine the bookstore applies a discount for bulk orders. This class has **no dependencies**, so it needs **no mocks**: the best kind of unit test.

~~~java src/main/java/com/example/bookstore/service/PriceCalculator.java
package com.example.bookstore.service;

import java.math.BigDecimal;
import java.math.RoundingMode;

import org.springframework.stereotype.Component;

@Component
public class PriceCalculator {

    public BigDecimal totalFor(BigDecimal unitPrice, int quantity) {
        if (quantity < 1) {
            throw new IllegalArgumentException("quantity must be at least 1");
        }
        BigDecimal gross = unitPrice.multiply(BigDecimal.valueOf(quantity));
        BigDecimal discountRate = quantity >= 50 ? new BigDecimal("0.15")
                : quantity >= 10 ? new BigDecimal("0.05")
                : BigDecimal.ZERO;
        return gross.subtract(gross.multiply(discountRate)).setScale(2, RoundingMode.HALF_UP);
    }
}
~~~

~~~java src/test/java/com/example/bookstore/service/PriceCalculatorTest.java
package com.example.bookstore.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.math.BigDecimal;
import java.util.stream.Stream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

class PriceCalculatorTest {

    private final PriceCalculator calculator = new PriceCalculator();

    @ParameterizedTest(name = "{1} x {0} = {2}")
    @CsvSource({
            "10.00, 1,  10.00",
            "10.00, 9,  90.00",
            "10.00, 10, 95.00",
            "10.00, 49, 465.50",
            "10.00, 50, 425.00",
            "19.99, 3,  59.97"
    })
    @DisplayName("applies tiered bulk discounts at the boundaries")
    void appliesDiscountTiers(BigDecimal unitPrice, int quantity, BigDecimal expected) {
        assertThat(calculator.totalFor(unitPrice, quantity)).isEqualByComparingTo(expected);
    }

    @ParameterizedTest
    @ValueSource(ints = {0, -1, -100})
    @DisplayName("rejects quantities below 1")
    void rejectsInvalidQuantity(int quantity) {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> calculator.totalFor(BigDecimal.TEN, quantity))
                .withMessageContaining("at least 1");
    }

    static Stream<Arguments> roundingCases() {
        return Stream.of(
                Arguments.of(new BigDecimal("0.333"), 3, new BigDecimal("1.00")),
                Arguments.of(new BigDecimal("1.005"), 1, new BigDecimal("1.01")),
                Arguments.of(new BigDecimal("0.01"), 10, new BigDecimal("0.10")));
    }

    @ParameterizedTest
    @MethodSource("roundingCases")
    @DisplayName("always rounds to 2 decimals HALF_UP")
    void roundsToCents(BigDecimal unitPrice, int quantity, BigDecimal expected) {
        BigDecimal total = calculator.totalFor(unitPrice, quantity);
        assertThat(total.scale()).isEqualTo(2);
        assertThat(total).isEqualByComparingTo(expected);
    }
}
~~~

^@CsvSource^ is ideal for tables of simple values: JUnit converts the strings to ^BigDecimal^ and ^int^ automatically. ^@MethodSource^ is for anything that does not fit in a string (objects, builders, nulls). The ^name^ attribute makes each row a readable entry in the report. Notice the test cases sit exactly on the **boundaries** (9/10, 49/50): bugs live at edges, so that is where to test.

### Step 9: Run the tests and read the coverage report

From the project root in PowerShell:

~~~powershell
# run every test
.\mvnw test

# run one class
.\mvnw test -Dtest=BookServiceTest

# run one nested group or method (Surefire pattern)
.\mvnw test -Dtest="BookServiceTest*FindAll"

# open the coverage report
start target\site\jacoco\index.html
~~~

Expected output (abbreviated):

~~~text
[INFO] -------------------------------------------------------
[INFO]  T E S T S
[INFO] -------------------------------------------------------
[INFO] Running com.example.bookstore.service.BookServiceTest
[INFO] Tests run: 13, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.412 s
[INFO] Running com.example.bookstore.service.BookServiceBddTest
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.031 s
[INFO] Running com.example.bookstore.service.PriceCalculatorTest
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.054 s
[INFO]
[INFO] Results:
[INFO]
[INFO] Tests run: 27, Failures: 0, Errors: 0, Skipped: 0
[INFO]
[INFO] --- jacoco:0.8.12:report (report) @ bookstore ---
[INFO] Loading execution data file C:\dev\bookstore\target\jacoco.exec
[INFO] BUILD SUCCESS
~~~

Half a second for the whole service layer. Compare that with starting the app and curling each endpoint. In the JaCoCo report, click into ^com.example.bookstore.service^ then ^BookService^: green lines ran, red lines did not, yellow diamonds on ^if^ lines mean only some branches ran.

To see a failure message, temporarily change ^containsExactly("A Book", "B Book")^ to ^containsExactly("B Book", "A Book")^:

~~~text
[ERROR] BookServiceTest$FindAll.findAll_returnsMappedPage:142
Actual and expected have the same elements but not in the same order, at index 0 actual element was:
  "A Book"
whereas expected element was:
  "B Book"
~~~

That is the AssertJ advantage: the message tells you exactly what went wrong without a debugger.

Also try the strict-stubs safety net: add ^when(bookRepository.existsByIsbn("x")).thenReturn(true);^ to ^delete_removesExisting^ and run it. You get ^UnnecessaryStubbingException^ pointing at the line. Remove it again.

---

## 3. Common Pitfalls & Best Practices

- **Starting Spring for a unit test.** Putting ^@SpringBootTest^ on ^BookServiceTest^ makes it 100 times slower and no longer isolated. Fix: plain JUnit plus ^MockitoExtension^ for services; save Spring for Lesson 5.2's integration tests.
- **Calling LocalDate.now() or Year.now() in business code.** Tests become date-dependent and flaky. Fix: inject a ^Clock^ bean and use ^Year.now(clock)^; pass ^Clock.fixed(...)^ in tests.
- **Mocking everything, including DTOs and pure helpers.** Tests then verify the mocks, not the behaviour, and break on every refactor. Fix: mock only boundary collaborators (repositories, clients); use real value objects, real pure classes, or fakes.
- **Verifying every interaction.** Littering tests with ^verify^ and ^verifyNoMoreInteractions^ ties them to implementation details. Fix: assert on returned results first; verify only interactions that are the behaviour (a save that must happen, a delete that must not).
- **Comparing BigDecimal with isEqualTo.** ^39.99^ and ^39.990^ are not equal by ^equals^. Fix: ^isEqualByComparingTo^ in AssertJ, ^compareTo^ in code.
- **Turning off strict stubs to silence errors.** Hides wrong-path bugs. Fix: delete the unused stub or, for one genuinely optional stub, use ^lenient()^.
- **Chasing 100% coverage.** Leads to assertion-free tests and tests of getters. Fix: use JaCoCo to spot untested branches; review tests for meaningful assertions; consider mutation testing.
- **Copy-pasted constructors in every test.** Adding a field breaks dozens of tests and hides what matters. Fix: a test data builder with valid defaults; override only the relevant field.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.`,
exercises:[
{"title":"Exercise 1 (Guided): Complete the BookService test suite","tasks":["Add a test in the ^UpdateAndDelete^ nested class proving that ^update^ throws ^BookNotFoundException^ when the id does not exist, and use ^verify(bookRepository, never())^ to show nothing else was called after ^findById^.","Add a ^@ParameterizedTest^ with ^@ValueSource(ints = {1449, 2027, 3000})^ proving ^create^ rejects each year with ^InvalidBookException^, and another with ^{1450, 2008, 2026}^ proving they are accepted (remember the fixed clock says 2026).","Add a pagination test that calls ^findAll(null, -5, 0)^ and uses an ^ArgumentCaptor<Pageable>^ to assert the service corrected the request to page 0 and size 1.","Run ^.\\mvnw test^, open ^target\\site\\jacoco\\index.html^ and confirm every branch of ^BookService^ is now green. Note which branch was yellow before."]},
{"title":"Exercise 2 (Challenge): A fake repository and a new rule","tasks":["Add a business rule to ^BookService.create^: a book published in the current year must cost at least 5.00, otherwise throw ^InvalidBookException^. Write the tests first (red), then the code (green).","Write a ^FakeBookRepository^ class in ^src/test/java/com/example/bookstore/testdata^ that stores books in a ^HashMap^ and assigns ids from an ^AtomicLong^. Implement only ^save^, ^findById^, ^existsById^, ^existsByIsbn^ and ^deleteById^; make the rest throw ^UnsupportedOperationException^. Hint: implementing ^JpaRepository^ is painful, so read how to extract a narrower interface or extend an abstract adapter.","Rewrite the create and delete tests against the fake (no Mockito) and compare: which version would survive renaming ^existsByIsbn^ to a ^findByIsbn(...).isPresent()^ check?","Configure the JaCoCo ^check^ goal in ^pom.xml^ to fail the build if line coverage of the ^service^ package drops below 80%. Read the jacoco-maven-plugin documentation for the ^rules^ and ^limits^ elements."]},
{"title":"Exercise 3 (Thinking): Judge the tests, not just the code","tasks":["Write one test that reaches 100% line coverage of ^PriceCalculator.totalFor^ but would still pass if the 50-copy discount were changed from 15% to 50%. Explain in a comment why coverage did not protect you, then delete it.","List three things in the Bookstore you would deliberately NOT unit test with mocks (for example the JPQL query from 3.2, the ^ProblemDetail^ JSON shape, the JWT filter) and say which test type from the pyramid fits each one better.","Read the Mockito documentation section on strict stubbing and write two sentences on why ^PotentialStubbingProblem^ saves debugging time compared to a mock silently returning null.","Explain in your own words why ^BookService^ needed a ^Clock^ constructor parameter, and how this connects to the constructor injection you learned in Lesson 1.1."]}
]
};
