LESSONS['3.2']={
md:String.raw`## 1. Concept & Theory

### Where the project stands

After Lesson 3.1, ^Book^ is a real JPA entity, H2 and PostgreSQL are configured, and a temporary ^DevDataSeeder^ wrote rows using the ^EntityManager^. But the REST API still reads and writes the in-memory ^Map^ inside ^BookService^ - the database and the API do not talk to each other yet. In this lesson we connect them: a ^BookRepository^ replaces the Map, we add search endpoints using derived queries and JPQL, and the list endpoint becomes paginated and sortable.

**Files in this lesson**

| File | Status |
|---|---|
| repository/BookRepository.java | new |
| dto/BookSummary.java | new (record projection) |
| dto/PageResponse.java | new (stable page DTO) |
| service/BookService.java | changed (Map removed, repository injected) |
| controller/BookController.java | changed (paging, search) |
| exception/DuplicateIsbnException.java | new |
| exception/GlobalExceptionHandler.java | changed (409 handler) |
| config/DevDataSeeder.java | changed (uses repository) |

Unchanged from Module 2: ^BookRequest^, ^BookResponse^, ^BookNotFoundException^.

### The repository pattern

A **repository** is an object that behaves like a collection of domain objects, hiding how they are stored. The service says "give me the book with ISBN X" and does not care whether that is SQL, a cache or a Map. Analogy: a librarian. You ask for a book by title; you do not walk into the archive yourself.

Before Spring Data, every project wrote the same DAO boilerplate: open EntityManager, create query, set parameters, handle no-result exceptions - hundreds of lines per entity. Spring Data JPA eliminates it: **you declare an interface, Spring writes the implementation**.

### The repository hierarchy

| Interface | Adds | Notes |
|---|---|---|
| Repository<T, ID> | Nothing (marker) | Expose only the methods you declare - good for strict APIs |
| CrudRepository<T, ID> | save, saveAll, findById, existsById, findAll, count, deleteById, delete | Returns Iterable for findAll |
| ListCrudRepository<T, ID> | Same, but returns List | Since Spring Data 3 |
| PagingAndSortingRepository<T, ID> | findAll(Sort), findAll(Pageable) | No longer extends CrudRepository since 3.0 |
| JpaRepository<T, ID> | flush, saveAndFlush, deleteAllInBatch, getReferenceById, List returns | Extends ListCrud + ListPagingAndSorting + QueryByExample |

Most projects extend ^JpaRepository^. If you want a narrow API (for example, books may never be deleted) extend ^Repository^ and declare only what you need - the compiler then enforces the rule.

### Magic under the hood: how an interface becomes a working bean

You never write ^class BookRepositoryImpl^. So who does? At startup:

1. ^JpaRepositoriesAutoConfiguration^ activates ^@EnableJpaRepositories^ for your application package.
1. A classpath scanner finds every interface extending ^Repository^.
1. For each, a ^JpaRepositoryFactoryBean^ is registered. It creates a **JDK dynamic proxy** implementing your interface.
1. Behind the proxy sits a ^SimpleJpaRepository^ instance - a real class in Spring Data that implements ^save^, ^findById^ etc. with the ^EntityManager^. Look at its source: ^save^ calls ^persist^ if the entity is new (id is null) and ^merge^ otherwise. It is annotated ^@Transactional(readOnly = true)^ at class level, with write methods overriding to read-write.
1. For every **custom** method you declared (like ^findByIsbn^), a ^QueryLookupStrategy^ decides how to implement it: an ^@Query^ annotation, a named query, or **derived from the method name**. The parsed query is built and **validated at startup**. A typo like ^findByTitel^ fails the application start with "No property 'titel' found for type 'Book'" - a great fail-fast feature.
1. When you call a method, the proxy's interceptor chain runs: exception translation (turning ^PersistenceException^ into Spring's ^DataAccessException^ hierarchy), transaction interceptor, then the query execution.

You can verify this yourself: log ^bookRepository.getClass()^ and you will see something like ^jdk.proxy2.$Proxy112^.

### Derived queries

Spring Data parses method names: a subject (^find...By^, ^exists...By^, ^count...By^, ^delete...By^) followed by predicates on entity properties.

| Keyword | Example | JPQL fragment |
|---|---|---|
| And / Or | findByTitleAndPublishedYear | where title = ?1 and publishedYear = ?2 |
| Between | findByPriceBetween | price between ?1 and ?2 |
| LessThan / GreaterThanEqual | findByPublishedYearLessThan | publishedYear < ?1 |
| Containing + IgnoreCase | findByTitleContainingIgnoreCase | upper(title) like upper('%x%') |
| StartingWith | findByIsbnStartingWith | isbn like 'x%' |
| In | findByFormatIn(Collection) | format in ?1 |
| IsNull / IsNotNull | findByUpdatedAtIsNull | updatedAt is null |
| OrderBy | findByPublishedYearOrderByTitleAsc | order by title asc |
| Top / First | findTop5ByOrderByPriceDesc | limit 5 |

Return types you can use: ^Optional<Book>^ for zero-or-one, ^List<Book>^, ^Page<Book>^, ^Slice<Book>^, ^Stream<Book>^ (must be closed and used inside a transaction), ^boolean^ for exists, ^long^ for count.

**Rule of thumb**: derived queries are excellent for one or two conditions. Once the method name reads like a sentence (^findByTitleContainingIgnoreCaseAndPriceLessThanAndPublishedYearGreaterThanOrderByPriceAsc^), switch to ^@Query^.

### Optional and existsBy

Single-result methods should return ^Optional^ - it forces the caller to decide what "not found" means. In the service we map it to our ^BookNotFoundException^ (404). For uniqueness checks use ^existsByIsbn^: Spring generates a query that stops at the first match (^select ... fetch first 1 rows only^), cheaper than loading an entity or counting all rows.

### JPQL with @Query

**JPQL** (Jakarta Persistence Query Language) looks like SQL, but it queries **entities and their fields**, not tables and columns. ^select b from Book b where b.publishedYear > :year^ uses the class name ^Book^ and the Java field ^publishedYear^, never ^books.published_year^. Hibernate translates it to the dialect of your database, so the same query runs on H2 and PostgreSQL.

Always use **named parameters** (^:year^ with ^@Param("year")^) - they are readable and immune to SQL injection because values are bound, never concatenated. Since Spring Boot 3.2 (with the ^-parameters^ compiler flag, set by the Boot parent) ^@Param^ can even be omitted, but keeping it is explicit and safe.

### Native queries: the caveat

^@Query(value = "...", nativeQuery = true)^ sends raw SQL. Use it for database-specific features (PostgreSQL full-text search, window functions, ^jsonb^ operators). Costs: it ties you to one database (your H2 dev profile may break), it is not validated at startup, the result mapping is manual, and pagination requires an explicit ^countQuery^. Prefer JPQL; reach for native SQL deliberately.

### Projections: read only what you need

Loading full entities for a list page means loading every column and putting every row into the persistence context (with snapshots for dirty checking). For read-only lists, a **projection** is lighter.

- **Interface projection**: declare an interface with getters (^String getTitle()^); Spring creates a proxy over the result. Convenient, slight runtime overhead.
- **Class/record projection (DTO projection)**: ^select new com.example.bookstore.dto.BookSummary(b.id, b.title, b.price) from Book b^ - Hibernate calls the record constructor directly. Fastest, type-safe, not managed (no dirty checking). Since Spring Data 3 a derived method can also return a record if its constructor parameter names match properties.

### Pagination and sorting

Never return "all books". Today it is 20; in a year it is 2 million, and one request loads them all into memory. Spring Data models paging with:

| Type | What it is |
|---|---|
| Pageable / PageRequest | Input: page number (0-based), size, Sort |
| Sort | Order by one or more properties with direction |
| Page<T> | Content plus total elements and total pages - requires a COUNT query |
| Slice<T> | Content plus "is there a next page?" - fetches size+1 rows, no COUNT |

Spring MVC resolves a ^Pageable^ controller parameter from query params automatically: ^?page=0&size=20&sort=price,desc&sort=title^. ^@PageableDefault^ sets defaults, and ^spring.data.web.pageable.max-page-size^ (we set 100 in Lesson 3.1) prevents a client from asking for ^size=1000000^.

**The cost of COUNT**: a ^Page^ runs two queries: the data query with ^limit/offset^ and a ^select count(*)^ with the same where clause. On a large PostgreSQL table, count requires scanning (PostgreSQL has no cached row count due to MVCC) and can cost more than the data query itself. For infinite scrolling or "next" buttons, use ^Slice^. Also note offset paging gets slower for deep pages (^offset 100000^ still reads 100000 rows); for very large datasets, keyset (cursor) paging via Spring Data's ^ScrollPosition^/^Window^ API is the answer.

**Do not serialize Page directly**. Jackson-serializing ^PageImpl^ exposes internal structure (^pageable^, ^sort^ objects) that may change between versions; Spring Data 3.3+ even logs a warning. We return our own ^PageResponse^ record - a stable API contract.

### @Modifying: bulk updates and deletes

A JPQL ^update^ or ^delete^ needs ^@Modifying^ plus a transaction. Crucially, bulk statements go **straight to the database and bypass the persistence context** - managed entities in memory become stale, auditing listeners and ^@Version^ are not applied. Use ^@Modifying(clearAutomatically = true)^ to clear the context afterwards. Bulk operations are perfect for "raise all ebook prices by 10%", wrong for single-entity updates (use dirty checking).

## 2. Code Walkthrough

### Step 1: the repository

~~~java src/main/java/com/example/bookstore/repository/BookRepository.java
package com.example.bookstore.repository;

import com.example.bookstore.dto.BookSummary;
import com.example.bookstore.model.Book;
import com.example.bookstore.model.BookFormat;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Slice;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.math.BigDecimal;
import java.util.List;
import java.util.Optional;

public interface BookRepository extends JpaRepository<Book, Long> {

    // ---- Derived queries ----
    Optional<Book> findByIsbn(String isbn);

    boolean existsByIsbn(String isbn);

    boolean existsByIsbnAndIdNot(String isbn, Long id);

    Page<Book> findByTitleContainingIgnoreCase(String title, Pageable pageable);

    List<Book> findByPriceBetweenOrderByPriceAsc(BigDecimal min, BigDecimal max);

    List<Book> findTop5ByOrderByCreatedAtDesc();

    long countByFormat(BookFormat format);

    // ---- JPQL with named parameters ----
    @Query("""
           select b from Book b
           where b.publishedYear between :fromYear and :toYear
             and b.price <= :maxPrice
           """)
    Page<Book> search(@Param("fromYear") int fromYear,
                      @Param("toYear") int toYear,
                      @Param("maxPrice") BigDecimal maxPrice,
                      Pageable pageable);

    // ---- DTO (record) projection: no entities, no dirty checking ----
    @Query("""
           select new com.example.bookstore.dto.BookSummary(b.id, b.title, b.price)
           from Book b
           where b.format = :format
           """)
    Slice<BookSummary> findSummariesByFormat(@Param("format") BookFormat format, Pageable pageable);

    // ---- Interface projection ----
    interface TitleOnly {
        String getTitle();
        String getIsbn();
    }

    List<TitleOnly> findByPublishedYear(int publishedYear);

    // ---- Native query (PostgreSQL + H2 compatible here, but not validated at startup) ----
    @Query(value = "select * from books where extract(year from created_at) = :year",
           countQuery = "select count(*) from books where extract(year from created_at) = :year",
           nativeQuery = true)
    Page<Book> findCreatedInYearNative(@Param("year") int year, Pageable pageable);

    // ---- Bulk update ----
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update Book b set b.price = b.price * :factor where b.format = :format")
    int adjustPrices(@Param("format") BookFormat format, @Param("factor") BigDecimal factor);
}
~~~

Notice: no implementation, no annotations on the interface (^@Repository^ is not needed - Spring Data detects it). Java text blocks keep JPQL readable.

### Step 2: the projection and page DTOs

~~~java src/main/java/com/example/bookstore/dto/BookSummary.java
package com.example.bookstore.dto;

import java.math.BigDecimal;

public record BookSummary(Long id, String title, BigDecimal price) {
}
~~~

~~~java src/main/java/com/example/bookstore/dto/PageResponse.java
package com.example.bookstore.dto;

import org.springframework.data.domain.Page;

import java.util.List;
import java.util.function.Function;

/** Stable JSON contract for paged results - never expose PageImpl directly. */
public record PageResponse<T>(
        List<T> content,
        int page,
        int size,
        long totalElements,
        int totalPages,
        boolean first,
        boolean last) {

    public static <E, T> PageResponse<T> from(Page<E> page, Function<E, T> mapper) {
        return new PageResponse<>(
                page.getContent().stream().map(mapper).toList(),
                page.getNumber(),
                page.getSize(),
                page.getTotalElements(),
                page.getTotalPages(),
                page.isFirst(),
                page.isLast());
    }
}
~~~

For reference, the unchanged DTOs from Module 2 (shown so this lesson compiles on its own):

~~~java src/main/java/com/example/bookstore/dto/BookRequest.java
package com.example.bookstore.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

public record BookRequest(
        @NotBlank @Size(max = 200) String title,
        @NotBlank @Pattern(regexp = "[0-9-]{10,17}", message = "must be a valid ISBN") String isbn,
        @NotNull @DecimalMin(value = "0.00") BigDecimal price,
        @Min(1450) @Max(2100) int publishedYear) {
}
~~~

~~~java src/main/java/com/example/bookstore/dto/BookResponse.java
package com.example.bookstore.dto;

import com.example.bookstore.model.Book;

import java.math.BigDecimal;

public record BookResponse(Long id, String title, String isbn, BigDecimal price, int publishedYear) {

    public static BookResponse from(Book book) {
        return new BookResponse(book.getId(), book.getTitle(), book.getIsbn(),
                book.getPrice(), book.getPublishedYear());
    }
}
~~~

### Step 3: a conflict exception

~~~java src/main/java/com/example/bookstore/exception/DuplicateIsbnException.java
package com.example.bookstore.exception;

public class DuplicateIsbnException extends RuntimeException {
    public DuplicateIsbnException(String isbn) {
        super("A book with ISBN " + isbn + " already exists");
    }
}
~~~

### Step 4: the service, now backed by the database

The Map, the ^AtomicLong^ id counter and the manual copying are gone. Note how ^update^ has no ^save^ call - dirty checking from Lesson 3.1 does the work inside the transaction. (Lesson 3.3 explains ^@Transactional^ in full depth; for now: it opens a persistence context and commits at the end of the method.)

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.BookSummary;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.model.Book;
import com.example.bookstore.model.BookFormat;
import com.example.bookstore.repository.BookRepository;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Slice;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;

@Service
@Transactional(readOnly = true)
public class BookService {

    private final BookRepository bookRepository;

    public BookService(BookRepository bookRepository) {
        this.bookRepository = bookRepository;
    }

    public PageResponse<BookResponse> findAll(Pageable pageable) {
        return PageResponse.from(bookRepository.findAll(pageable), BookResponse::from);
    }

    public BookResponse findById(Long id) {
        return BookResponse.from(getBook(id));
    }

    public BookResponse findByIsbn(String isbn) {
        return bookRepository.findByIsbn(isbn)
                .map(BookResponse::from)
                .orElseThrow(() -> new BookNotFoundException("isbn " + isbn));
    }

    public PageResponse<BookResponse> searchByTitle(String title, Pageable pageable) {
        return PageResponse.from(
                bookRepository.findByTitleContainingIgnoreCase(title, pageable), BookResponse::from);
    }

    public PageResponse<BookResponse> search(int fromYear, int toYear, BigDecimal maxPrice, Pageable pageable) {
        return PageResponse.from(
                bookRepository.search(fromYear, toYear, maxPrice, pageable), BookResponse::from);
    }

    public Slice<BookSummary> summariesByFormat(BookFormat format, Pageable pageable) {
        return bookRepository.findSummariesByFormat(format, pageable);
    }

    @Transactional
    public BookResponse create(BookRequest request) {
        if (bookRepository.existsByIsbn(request.isbn())) {
            throw new DuplicateIsbnException(request.isbn());
        }
        Book book = new Book(request.title(), request.isbn(), request.price(), request.publishedYear());
        return BookResponse.from(bookRepository.save(book));
    }

    @Transactional
    public BookResponse update(Long id, BookRequest request) {
        Book book = getBook(id);                                   // MANAGED
        if (bookRepository.existsByIsbnAndIdNot(request.isbn(), id)) {
            throw new DuplicateIsbnException(request.isbn());
        }
        book.updateDetails(request.title(), request.isbn(), request.price(), request.publishedYear());
        return BookResponse.from(book);                            // UPDATE happens at commit
    }

    @Transactional
    public void delete(Long id) {
        if (!bookRepository.existsById(id)) {
            throw new BookNotFoundException("id " + id);
        }
        bookRepository.deleteById(id);
    }

    @Transactional
    public int adjustPrices(BookFormat format, BigDecimal factor) {
        return bookRepository.adjustPrices(format, factor);
    }

    private Book getBook(Long id) {
        return bookRepository.findById(id)
                .orElseThrow(() -> new BookNotFoundException("id " + id));
    }
}
~~~

The ^BookNotFoundException^ from Lesson 2.3 takes a descriptive string; if yours takes a ^Long^, add a second constructor. The service never returns entities to the controller - entities stay inside the transactional boundary, DTOs leave it.

> The existsByIsbn check has a race: two concurrent requests can both pass it. The database's ^uk_books_isbn^ constraint is the real guard; the handler below also maps ^DataIntegrityViolationException^ to 409 so the loser of the race still gets a clean response.

### Step 5: the controller

~~~java src/main/java/com/example/bookstore/controller/BookController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.BookSummary;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.model.BookFormat;
import com.example.bookstore.service.BookService;
import jakarta.validation.Valid;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Slice;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
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

import java.math.BigDecimal;
import java.net.URI;
import java.util.List;

@RestController
@RequestMapping("/api/books")
public class BookController {

    private final BookService bookService;

    public BookController(BookService bookService) {
        this.bookService = bookService;
    }

    @GetMapping
    public PageResponse<BookResponse> list(
            @PageableDefault(size = 20, sort = "title", direction = Sort.Direction.ASC) Pageable pageable) {
        return bookService.findAll(pageable);
    }

    @GetMapping("/{id}")
    public BookResponse get(@PathVariable Long id) {
        return bookService.findById(id);
    }

    @GetMapping("/isbn/{isbn}")
    public BookResponse getByIsbn(@PathVariable String isbn) {
        return bookService.findByIsbn(isbn);
    }

    @GetMapping("/search")
    public PageResponse<BookResponse> search(
            @RequestParam(required = false) String title,
            @RequestParam(defaultValue = "1450") int fromYear,
            @RequestParam(defaultValue = "2100") int toYear,
            @RequestParam(defaultValue = "1000000") BigDecimal maxPrice,
            @PageableDefault(size = 20, sort = "title") Pageable pageable) {
        if (title != null && !title.isBlank()) {
            return bookService.searchByTitle(title, pageable);
        }
        return bookService.search(fromYear, toYear, maxPrice, pageable);
    }

    @GetMapping("/summaries")
    public List<BookSummary> summaries(@RequestParam BookFormat format,
                                       @PageableDefault(size = 20, sort = "title") Pageable pageable) {
        Slice<BookSummary> slice = bookService.summariesByFormat(format, pageable);
        return slice.getContent();
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

### Step 6: map conflicts to 409

Add two handlers to the existing ^GlobalExceptionHandler^ (the rest of the class from Lesson 2.3 stays the same):

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
package com.example.bookstore.exception;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.mapping.PropertyReferenceException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.net.URI;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    @ExceptionHandler(BookNotFoundException.class)
    public ProblemDetail handleNotFound(BookNotFoundException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
        pd.setTitle("Book not found");
        pd.setType(URI.create("https://api.example.com/problems/book-not-found"));
        return pd;
    }

    @ExceptionHandler(DuplicateIsbnException.class)
    public ProblemDetail handleDuplicate(DuplicateIsbnException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, ex.getMessage());
        pd.setTitle("Duplicate ISBN");
        pd.setType(URI.create("https://api.example.com/problems/duplicate-isbn"));
        return pd;
    }

    /** Safety net when the DB constraint catches what the existsBy check missed (race condition). */
    @ExceptionHandler(DataIntegrityViolationException.class)
    public ProblemDetail handleIntegrity(DataIntegrityViolationException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT,
                "The request conflicts with existing data");
        pd.setTitle("Data conflict");
        return pd;   // never echo the SQL error to the client
    }

    /** ?sort=doesNotExist would otherwise be a 500. */
    @ExceptionHandler(PropertyReferenceException.class)
    public ProblemDetail handleBadSort(PropertyReferenceException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST,
                "Unknown sort property: " + ex.getPropertyName());
        pd.setTitle("Invalid sort parameter");
        return pd;
    }
}
~~~

### Step 7: seed through the repository

~~~java src/main/java/com/example/bookstore/config/DevDataSeeder.java
package com.example.bookstore.config;

import com.example.bookstore.model.Book;
import com.example.bookstore.model.BookFormat;
import com.example.bookstore.repository.BookRepository;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.List;

@Component
@Profile("!postgres")
public class DevDataSeeder implements ApplicationRunner {

    private final BookRepository bookRepository;

    public DevDataSeeder(BookRepository bookRepository) {
        this.bookRepository = bookRepository;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (bookRepository.count() > 0) {
            return;
        }
        Book refactoring = new Book("Refactoring", "978-0134757599", new BigDecimal("47.99"), 2018);
        refactoring.setFormat(BookFormat.HARDCOVER);
        Book ddd = new Book("Domain-Driven Design", "978-0321125217", new BigDecimal("54.99"), 2003);
        ddd.setFormat(BookFormat.HARDCOVER);
        bookRepository.saveAll(List.of(
                new Book("Dune", "978-0441172719", new BigDecimal("9.99"), 1965),
                new Book("Clean Code", "978-0132350884", new BigDecimal("37.50"), 2008),
                new Book("Effective Java", "978-0134685991", new BigDecimal("44.99"), 2018),
                new Book("Spring in Action", "978-1617297571", new BigDecimal("49.99"), 2022),
                refactoring, ddd));
    }
}
~~~

^saveAll^ runs in a single transaction (from ^SimpleJpaRepository^), so all six inserts commit together - and thanks to SEQUENCE with allocation 50, only one sequence call is made.

### Step 8: test it

~~~powershell
.\mvnw spring-boot:run
curl "http://localhost:8080/api/books?page=0&size=3&sort=price,desc"
~~~

~~~json
{
  "content": [
    {"id":6,"title":"Domain-Driven Design","isbn":"978-0321125217","price":54.99,"publishedYear":2003},
    {"id":4,"title":"Spring in Action","isbn":"978-1617297571","price":49.99,"publishedYear":2022},
    {"id":5,"title":"Refactoring","isbn":"978-0134757599","price":47.99,"publishedYear":2018}
  ],
  "page": 0,
  "size": 3,
  "totalElements": 6,
  "totalPages": 2,
  "first": true,
  "last": false
}
~~~

And the SQL log shows the two queries a ^Page^ costs:

~~~text
DEBUG org.hibernate.SQL :
    select b1_0.id, b1_0.created_at, b1_0.format, b1_0.isbn, b1_0.price,
           b1_0.published_year, b1_0.title, b1_0.updated_at
    from books b1_0
    order by b1_0.price desc
    offset ? rows fetch first ? rows only
DEBUG org.hibernate.SQL :
    select count(b1_0.id) from books b1_0
~~~

More requests to try:

~~~powershell
curl "http://localhost:8080/api/books/search?title=java"
curl "http://localhost:8080/api/books/search?fromYear=2000&toYear=2020&maxPrice=45"
curl "http://localhost:8080/api/books/summaries?format=HARDCOVER"
curl "http://localhost:8080/api/books/isbn/978-0441172719"
curl "http://localhost:8080/api/books?sort=nope"
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"Dune\",\"isbn\":\"978-0441172719\",\"price\":9.99,\"publishedYear\":1965}"
~~~

The last request returns ^HTTP/1.1 409^ with a ProblemDetail body:

~~~json
{
  "type": "https://api.example.com/problems/duplicate-isbn",
  "title": "Duplicate ISBN",
  "status": 409,
  "detail": "A book with ISBN 978-0441172719 already exists",
  "instance": "/api/books"
}
~~~

The summaries endpoint logs a single query with ^fetch first 21 rows only^ - the Slice asks for size + 1 rows to know whether a next page exists, and there is **no count query**.

Finally, restart with the ^postgres^ profile: the same code, same JPQL, now against PostgreSQL. Data survives restarts. The in-memory illusion of Module 2 is gone.

## 3. Common Pitfalls & Best Practices

- **Mistake:** returning ^List<Book>^ of all rows from a list endpoint. **Fix:** always accept a ^Pageable^, set a ^max-page-size^, and return a page DTO.
- **Mistake:** serializing ^Page^ or entities straight to JSON. **Fix:** map to records (^BookResponse^, ^PageResponse^) so the API contract is stable and lazy associations never leak.
- **Mistake:** using ^Page^ where nobody displays the total. **Fix:** use ^Slice^ to avoid a potentially expensive COUNT query; consider keyset scrolling for huge tables.
- **Mistake:** unreadable derived method names with five conditions. **Fix:** switch to ^@Query^ with JPQL and named parameters (or Specifications/Querydsl for dynamic filters).
- **Mistake:** calling ^save()^ after modifying a managed entity, or loading a whole entity just to check existence. **Fix:** rely on dirty checking inside the transaction; use ^existsBy...^ for existence checks.
- **Mistake:** forgetting that ^@Modifying^ bulk queries bypass the persistence context, auditing and ^@Version^. **Fix:** use ^clearAutomatically = true^ and reserve bulk statements for genuine batch operations.
- **Mistake:** concatenating user input into ^@Query^ strings or native SQL. **Fix:** always bind parameters (^:name^); this prevents SQL injection.
- **Mistake:** relying only on an application-level uniqueness check. **Fix:** keep the database unique constraint and translate ^DataIntegrityViolationException^ into 409.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Replace the Map with BookRepository","tasks":["Create ^BookRepository^, remove the Map and id counter from ^BookService^, and verify every endpoint from Module 2 still works with curl.","Log ^bookRepository.getClass()^ at startup and note the proxy class name; explain what object actually executes ^findById^.","Introduce a typo in a derived method name (e.g. ^findByTitel^) and read the startup error message, then fix it.","Call the list endpoint with ^size=500^ and confirm the page size is capped at 100.","Count the SQL statements produced by one ^GET /api/books^ request and by one ^GET /api/books/summaries^ request and explain the difference."]},
{"title":"Exercise 2 (Challenge): Richer queries","tasks":["Add a derived query that finds books by format and published year after a given year, returning a ^Page^, and expose it through a new endpoint.","Write a JPQL query that returns the average price per format as a record ^FormatStats(BookFormat format, BigDecimal avgPrice, long count)^ using a constructor expression and ^group by^.","Add an admin endpoint ^POST /api/books/prices/adjust?format=EBOOK&factor=1.10^ that calls ^adjustPrices^ and returns the number of updated rows; check what happens to ^updatedAt^ and explain why.","Read the Spring Data JPA reference on 'Scrolling' and sketch how ^GET /api/books^ would look with keyset-based ^Window^ results instead of offset paging."]},
{"title":"Exercise 3 (Thinking): Choosing the right tool","tasks":["Explain when you would choose ^Page^, ^Slice^ and keyset scrolling, with one realistic UI example each.","List three disadvantages of native queries compared with JPQL and one legitimate reason to use them in PostgreSQL.","Describe the race condition in the create method and why the database constraint still guarantees correctness.","Compare an interface projection with a record projection: how is each created at runtime and which one would you pick for a high-traffic list endpoint?"]}
]
};
