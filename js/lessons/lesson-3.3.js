LESSONS['3.3']={
md:String.raw`## 1. Concept & Theory

### Where the project stands

Our Bookstore API now persists books in H2 or PostgreSQL through ^BookRepository^, supports derived queries, JPQL, projections and paging, and returns stable ^PageResponse^ DTOs. But a bookstore with only books is unrealistic: books have **authors** and belong to **categories**. In this lesson we model those relationships, meet the most famous JPA performance bug (**N+1**), learn to control **fetching**, and finally understand **@Transactional** properly - which we have been using since Lesson 3.1 without explaining all of its rules.

**Files in this lesson**

| File | Status |
|---|---|
| model/Author.java | new |
| model/Category.java | new |
| model/Book.java | changed (author, categories, @Version) |
| repository/AuthorRepository.java | new |
| repository/CategoryRepository.java | new |
| repository/BookRepository.java | changed (fetch queries, EntityGraph) |
| dto/AuthorRequest.java, dto/AuthorResponse.java | new |
| dto/BookRequest.java, dto/BookResponse.java | changed (authorId, categories, version) |
| service/AuthorService.java | new |
| service/BookService.java | changed |
| controller/AuthorController.java | new |
| exception/GlobalExceptionHandler.java | changed (optimistic locking 409) |
| config/DevDataSeeder.java | changed |

### Relationships in a relational database vs in Java

In Java, an author "has" a list of books: ^author.getBooks()^. In SQL, there is no list - the **books** table has a foreign key column ^author_id^. The relationship lives on exactly one side, in one column. JPA has to reconcile this: Java lets you navigate in both directions; the database stores only one pointer.

| Relationship | Java | Database |
|---|---|---|
| Many books - one author | Book.author and Author.books | books.author_id foreign key |
| Many books - many categories | Book.categories and Category.books | join table book_categories(book_id, category_id) |

### The owning side and mappedBy

In a bidirectional relationship, both Java sides refer to each other, but only one side is the **owning side** - the side Hibernate looks at when writing the foreign key. The other side is the **inverse side**, marked with ^mappedBy^ ("this is just a mirror of the field named X on the other entity").

- For ^@ManyToOne^ / ^@OneToMany^, the **many side** (^Book.author^) always owns the foreign key. ^Author.books^ is ^@OneToMany(mappedBy = "author")^.
- For ^@ManyToMany^, you choose: the side with ^@JoinTable^ owns it. We let ^Book.categories^ own it; ^Category.books^ uses ^mappedBy = "categories"^.

**The consequence everyone trips over**: if you only do ^author.getBooks().add(book)^ and never set ^book.setAuthor(author)^, nothing is written - Hibernate ignores the inverse side. The fix is **helper methods** that keep both sides in sync: ^author.addBook(book)^ adds to the list **and** sets the back reference.

Analogy: a library's catalogue card (owning side) and a friend's memory of which books you borrowed (inverse side). Only the card counts legally; you keep your friend's memory consistent so conversations make sense.

### Cascade and orphanRemoval

**Cascade** propagates entity operations from parent to children: with ^cascade = CascadeType.ALL^ on ^Author.books^, persisting an author persists its new books; removing an author removes its books. **orphanRemoval = true** goes further: removing a book from the author's collection deletes the book row.

Use cascade only where there is real **ownership** (parent-child lifecycle, e.g. Order - OrderLine). Is a book owned by its author? In our domain we decide: books are aggregate roots in their own right (they have their own endpoints), so we cascade only ^PERSIST^ and ^MERGE^ from author to books, and we do **not** use orphanRemoval. Never cascade ^REMOVE^ on ^@ManyToMany^: deleting a book would delete the shared "Science Fiction" category and everything else in it.

### LAZY vs EAGER

**Fetching** decides when associated data is loaded:

| Fetch type | Behaviour | JPA default for |
|---|---|---|
| EAGER | Loaded immediately with the owner, always | @ManyToOne, @OneToOne |
| LAZY | A proxy or uninitialized collection; loaded on first access | @OneToMany, @ManyToMany |

**Make every association LAZY**, including ^@ManyToOne(fetch = FetchType.LAZY)^. EAGER is a decision taken once, in the mapping, for every query forever - you cannot turn it off per use case, and with JPQL queries it often results in extra SELECTs anyway. LAZY lets each use case decide explicitly what to fetch.

Under the hood, LAZY ^@ManyToOne^ is a **Hibernate proxy** - a runtime subclass of ^Author^ holding only the id. LAZY collections are a ^PersistentBag^ / ^PersistentSet^ - Hibernate's own collection implementations that run a query on first access. This is why entities must be non-final (Lesson 3.1).

### LazyInitializationException

A proxy can only load itself while its persistence context is open. Access it after the transaction ended (for example in the controller, or during JSON serialization) and Hibernate throws:

~~~text
org.hibernate.LazyInitializationException: could not initialize proxy [com.example.bookstore.model.Author#1] - no Session
~~~

Fixes, from best to worst:

| Fix | How | Verdict |
|---|---|---|
| JOIN FETCH in JPQL | select b from Book b join fetch b.author | Explicit, one query. Preferred. |
| @EntityGraph | Annotation on repository method naming attributes to fetch | Same effect, works with derived queries |
| DTO projection | select new ...(b.title, a.name) from Book b join b.author a | Best for read-only views |
| Map to DTO inside the @Transactional service | Access what you need before returning | Fine, but watch N+1 |
| open-in-view = true | Keeps session open until the HTTP response is written | Never - see below |
| FetchType.EAGER | Change the mapping | Never as a fix |

**Why never Open Session in View (OSIV)?** Spring Boot enables ^spring.jpa.open-in-view^ by default (with a warning). It binds the persistence context to the whole HTTP request, so lazy loading "just works" in the controller and Jackson. The price: a database connection is held for the entire request including JSON rendering and slow clients; lazy queries fire from the web layer invisibly, outside any transaction (auto-commit, one connection per statement); N+1 problems hide until production load. We disabled it in Lesson 3.1 - keep it that way, and fetch deliberately in the service.

### The N+1 problem

Load 20 books (1 query), then for each book access ^book.getAuthor().getName()^. Each access initializes a proxy with its own SELECT: 1 + 20 = 21 queries. For a page of 100 books with authors and categories it is 201 queries. Each is fast on your laptop; in production, with 1 ms network latency and concurrency, the endpoint crawls and the database burns CPU. It is the number-one JPA performance issue, and it is invisible unless you look at the SQL log - which is why we enabled it. We will reproduce and fix it in the walkthrough.

Note that ^join fetch^ on a **collection** combined with paging is dangerous: Hibernate cannot apply ^limit^ in SQL because rows are multiplied per collection element; it fetches everything and pages in memory (warning HHH90003004). For collections in paged queries, use a second query by ids, or ^@BatchSize^ / ^hibernate.default_batch_fetch_size^ which turns N queries into a few ^where id in (...)^ queries.

### @Transactional: what it really does

A **transaction** groups operations into an all-or-nothing unit (ACID: Atomic, Consistent, Isolated, Durable). Transfer money: debit and credit both happen, or neither.

Remember Lesson 1.1: Spring wraps beans in **proxies** to add behaviour. ^@Transactional^ is the canonical example. When the controller calls ^bookService.create(...)^, it actually calls a proxy. The ^TransactionInterceptor^:

1. Asks the ^JpaTransactionManager^ for a transaction according to the annotation attributes.
1. Gets a connection from Hikari, sets autocommit false, binds the EntityManager and connection to the **current thread** (a ThreadLocal via ^TransactionSynchronizationManager^).
1. Invokes your real method.
1. On normal return: flush (dirty checking), commit, release the connection.
1. On exception: rollback if the rollback rules say so, then rethrow.

### Propagation

What happens when a transactional method calls another transactional method?

| Propagation | Behaviour |
|---|---|
| REQUIRED (default) | Join the existing transaction or start a new one |
| REQUIRES_NEW | Suspend the current one, run in a brand-new independent transaction (e.g. audit log that must survive a rollback) |
| MANDATORY | Must be called inside a transaction, else exception |
| SUPPORTS | Join if present, else run without |
| NOT_SUPPORTED | Suspend any transaction and run without |
| NEVER | Throw if a transaction exists |
| NESTED | Savepoint inside the current transaction (JDBC only, not with JPA by default) |

A subtle one with REQUIRED: if an inner method throws a runtime exception and the outer catches it, the shared transaction is already **marked rollback-only**, and the outer commit throws ^UnexpectedRollbackException^. You cannot "catch and continue" a failed participating transaction.

### Isolation (basics)

Isolation decides what concurrent transactions see of each other. PostgreSQL's default is **READ COMMITTED**: you never see uncommitted data, but two reads in the same transaction may see different committed values. ^REPEATABLE_READ^ and ^SERIALIZABLE^ give stronger guarantees at the cost of serialization failures you must retry. For most CRUD APIs the default plus **optimistic locking** (below) is the right combination; set ^@Transactional(isolation = ...)^ only with a specific anomaly in mind.

### readOnly = true

^@Transactional(readOnly = true)^ is not just documentation. Spring sets the Hibernate session to ^FlushMode.MANUAL^ and read-only, so Hibernate **skips dirty checking snapshots** (less memory, less CPU), and the JDBC connection is flagged read-only (some drivers and routing data sources send it to a replica). We put it on the ^BookService^ class in Lesson 3.2 and override with ^@Transactional^ on write methods.

### Rollback rules: checked vs unchecked

By default, Spring rolls back on **unchecked** exceptions (^RuntimeException^ and ^Error^) and **commits** on **checked** exceptions. This EJB-inherited rule surprises everyone: a method throwing ^IOException^ commits whatever it wrote before. Options: use unchecked exceptions for business errors (as we do: ^BookNotFoundException^, ^DuplicateIsbnException^ extend ^RuntimeException^), or declare ^@Transactional(rollbackFor = Exception.class)^. Catching an exception inside the method and not rethrowing means no rollback at all.

### The self-invocation pitfall (callback to Lesson 1.1)

Because transactions are applied by a proxy **around** the bean, a call from one method of a bean to another method of **the same bean** goes through ^this^, not through the proxy - so the annotation on the inner method is **ignored**:

~~~java
@Service
public class ImportService {
    public void importAll(List<BookRequest> requests) {
        for (BookRequest r : requests) {
            importOne(r);        // this.importOne() - NO proxy, NO new transaction!
        }
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void importOne(BookRequest r) { ... }
}
~~~

Same pitfall for ^private^ methods (proxies cannot intercept them) and for calling ^@Transactional^ methods from a constructor. Fix: move the inner method to a separate bean and inject it; that is usually the cleaner design anyway.

### Where transaction boundaries belong

The **service layer** defines units of work: one use case = one transaction. Not the controller (it should not know about persistence, and should not hold a connection while handling HTTP concerns), not the repository alone (each repository call would be its own transaction, losing atomicity across calls). Keep transactions **short**: no remote HTTP calls, no email sending, no file uploads inside a transaction - each holds a DB connection and locks while waiting.

### Optimistic locking with @Version

Two admins open the same book. Admin A changes the price to 12.99 and saves; Admin B, still looking at the old version, changes the title and saves - silently overwriting A's price. This is the **lost update** problem.

Add a ^@Version Long version^ field. Hibernate then writes ^update books set ..., version = 4 where id = ? and version = 3^. If another transaction already incremented the version, zero rows are updated and Hibernate throws ^OptimisticLockException^ (Spring wraps it as ^ObjectOptimisticLockingFailureException^). We return **409 Conflict**; the client reloads and retries. No database locks are held between read and write - "optimistic" because conflicts are assumed rare. For REST, the client must send back the version it read (in the body or as an ^If-Match^ ETag header), otherwise you only protect the few milliseconds inside one transaction.

## 2. Code Walkthrough

### Step 1: the Author entity

~~~java src/main/java/com/example/bookstore/model/Author.java
package com.example.bookstore.model;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.SequenceGenerator;
import jakarta.persistence.Table;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

@Entity
@Table(name = "authors")
public class Author {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "author_seq")
    @SequenceGenerator(name = "author_seq", sequenceName = "author_seq", allocationSize = 50)
    private Long id;

    @Column(nullable = false, length = 150)
    private String name;

    // Inverse side: the foreign key lives in books.author_id (Book.author owns it)
    @OneToMany(mappedBy = "author", cascade = {CascadeType.PERSIST, CascadeType.MERGE})
    private List<Book> books = new ArrayList<>();

    protected Author() {
    }

    public Author(String name) {
        this.name = name;
    }

    /** Keeps BOTH sides in sync - the only safe way to link a book. */
    public void addBook(Book book) {
        books.add(book);
        book.setAuthor(this);
    }

    public void removeBook(Book book) {
        books.remove(book);
        book.setAuthor(null);
    }

    public Long getId() { return id; }
    public String getName() { return name; }
    public void rename(String name) { this.name = name; }

    /** Read-only view: callers must use addBook/removeBook. */
    public List<Book> getBooks() { return Collections.unmodifiableList(books); }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Author other)) return false;
        return id != null && Objects.equals(id, other.getId());
    }

    @Override
    public int hashCode() { return Author.class.hashCode(); }

    @Override
    public String toString() { return "Author[id=" + id + ", name=" + name + "]"; }
}
~~~

### Step 2: the Category entity

~~~java src/main/java/com/example/bookstore/model/Category.java
package com.example.bookstore.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.SequenceGenerator;
import jakarta.persistence.Table;

import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

@Entity
@Table(name = "categories")
public class Category {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "category_seq")
    @SequenceGenerator(name = "category_seq", sequenceName = "category_seq", allocationSize = 50)
    private Long id;

    @Column(nullable = false, unique = true, length = 80)
    private String name;

    // Inverse side of the many-to-many; Book.categories owns the join table
    @ManyToMany(mappedBy = "categories")
    private Set<Book> books = new HashSet<>();

    protected Category() {
    }

    public Category(String name) {
        this.name = name;
    }

    public Long getId() { return id; }
    public String getName() { return name; }
    Set<Book> getBooksInternal() { return books; }   // package-private, used by Book helpers

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Category other)) return false;
        return id != null && Objects.equals(id, other.getId());
    }

    @Override
    public int hashCode() { return Category.class.hashCode(); }

    @Override
    public String toString() { return "Category[id=" + id + ", name=" + name + "]"; }
}
~~~

We use a ^Set^ for many-to-many: with a ^List^ (a "bag"), Hibernate deletes **all** join rows and reinserts them when you remove one element. The constant hashCode from Lesson 3.1 makes ^Set^ safe for new entities.

### Step 3: Book gains author, categories and a version

~~~java src/main/java/com/example/bookstore/model/Book.java
package com.example.bookstore.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EntityListeners;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.ForeignKey;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.SequenceGenerator;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import jakarta.persistence.Version;
import org.springframework.data.annotation.CreatedDate;
import org.springframework.data.annotation.LastModifiedDate;
import org.springframework.data.jpa.domain.support.AuditingEntityListener;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Collections;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

@Entity
@Table(name = "books",
       uniqueConstraints = @UniqueConstraint(name = "uk_books_isbn", columnNames = "isbn"))
@EntityListeners(AuditingEntityListener.class)
public class Book {

    @Id
    @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "book_seq")
    @SequenceGenerator(name = "book_seq", sequenceName = "book_seq", allocationSize = 50)
    private Long id;

    @Version
    private Long version;

    @Column(nullable = false, length = 200)
    private String title;

    @Column(nullable = false, length = 17)
    private String isbn;

    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    @Column(name = "published_year", nullable = false)
    private int publishedYear;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private BookFormat format = BookFormat.PAPERBACK;

    // OWNING side: this field writes books.author_id. LAZY overrides the EAGER default.
    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "author_id", nullable = false, foreignKey = @ForeignKey(name = "fk_books_author"))
    private Author author;

    // OWNING side of the many-to-many: defines the join table
    @ManyToMany
    @JoinTable(name = "book_categories",
               joinColumns = @JoinColumn(name = "book_id"),
               inverseJoinColumns = @JoinColumn(name = "category_id"))
    private Set<Category> categories = new HashSet<>();

    @CreatedDate
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @LastModifiedDate
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Book() {
    }

    public Book(String title, String isbn, BigDecimal price, int publishedYear) {
        this.title = title;
        this.isbn = isbn;
        this.price = price;
        this.publishedYear = publishedYear;
    }

    public void updateDetails(String title, String isbn, BigDecimal price, int publishedYear) {
        this.title = title;
        this.isbn = isbn;
        this.price = price;
        this.publishedYear = publishedYear;
    }

    public void addCategory(Category category) {
        categories.add(category);
        category.getBooksInternal().add(this);
    }

    public void removeCategory(Category category) {
        categories.remove(category);
        category.getBooksInternal().remove(this);
    }

    /** Package-private: use Author.addBook to keep both sides consistent. */
    void setAuthor(Author author) { this.author = author; }

    public Long getId() { return id; }
    public Long getVersion() { return version; }
    public String getTitle() { return title; }
    public String getIsbn() { return isbn; }
    public BigDecimal getPrice() { return price; }
    public int getPublishedYear() { return publishedYear; }
    public BookFormat getFormat() { return format; }
    public void setFormat(BookFormat format) { this.format = format; }
    public Author getAuthor() { return author; }
    public Set<Category> getCategories() { return Collections.unmodifiableSet(categories); }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof Book other)) return false;
        return id != null && Objects.equals(id, other.getId());
    }

    @Override
    public int hashCode() { return Book.class.hashCode(); }

    @Override
    public String toString() {
        return "Book[id=" + id + ", title=" + title + ", isbn=" + isbn + "]";   // no author, no categories!
    }
}
~~~

Moving the book to another author: because ^setAuthor^ is package-private, application code calls ^oldAuthor.removeBook(book)^ then ^newAuthor.addBook(book)^, or we add a ^Book.changeAuthor^ method. The generated schema now includes:

~~~text
create table authors (id bigint not null, name varchar(150) not null, primary key (id))
create table book_categories (book_id bigint not null, category_id bigint not null, primary key (book_id, category_id))
alter table if exists books add column author_id bigint not null
alter table if exists books add constraint fk_books_author foreign key (author_id) references authors
~~~

> Foreign key columns are not indexed automatically in PostgreSQL. In your Flyway migration add ^create index idx_books_author_id on books(author_id)^ - otherwise every "books of author X" query and every author delete scans the whole books table.

### Step 4: repositories

~~~java src/main/java/com/example/bookstore/repository/AuthorRepository.java
package com.example.bookstore.repository;

import com.example.bookstore.model.Author;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.Optional;

public interface AuthorRepository extends JpaRepository<Author, Long> {

    @Query("select a from Author a left join fetch a.books where a.id = :id")
    Optional<Author> findByIdWithBooks(@Param("id") Long id);
}
~~~

~~~java src/main/java/com/example/bookstore/repository/CategoryRepository.java
package com.example.bookstore.repository;

import com.example.bookstore.model.Category;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface CategoryRepository extends JpaRepository<Category, Long> {

    Optional<Category> findByNameIgnoreCase(String name);

    List<Category> findByNameIn(Collection<String> names);
}
~~~

Add fetch-aware methods to ^BookRepository^ (the Lesson 3.2 methods stay; only the new ones are shown with the full interface header):

~~~java src/main/java/com/example/bookstore/repository/BookRepository.java
package com.example.bookstore.repository;

import com.example.bookstore.model.Book;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface BookRepository extends JpaRepository<Book, Long> {

    // ... all methods from Lesson 3.2 unchanged ...

    // Fix 1: JOIN FETCH - author and categories in ONE query for a single book
    @Query("""
           select distinct b from Book b
           join fetch b.author
           left join fetch b.categories
           where b.id = :id
           """)
    Optional<Book> findDetailedById(@Param("id") Long id);

    // Fix 2: EntityGraph on a paged query. To-one association = safe to fetch with paging.
    @EntityGraph(attributePaths = "author")
    @Query("select b from Book b")
    Page<Book> findAllWithAuthor(Pageable pageable);

    // Second step for collections: load categories for the ids of the current page only
    @Query("select distinct b from Book b left join fetch b.categories where b in :books")
    List<Book> fetchCategories(@Param("books") List<Book> books);
}
~~~

### Step 5: DTOs

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
import java.util.Set;

public record BookRequest(
        @NotBlank @Size(max = 200) String title,
        @NotBlank @Pattern(regexp = "[0-9-]{10,17}", message = "must be a valid ISBN") String isbn,
        @NotNull @DecimalMin(value = "0.00") BigDecimal price,
        @Min(1450) @Max(2100) int publishedYear,
        @NotNull Long authorId,
        Set<String> categories,
        Long version) {          // null on create; required on update for optimistic locking

    public Set<String> categoriesOrEmpty() {
        return categories == null ? Set.of() : categories;
    }
}
~~~

~~~java src/main/java/com/example/bookstore/dto/BookResponse.java
package com.example.bookstore.dto;

import com.example.bookstore.model.Book;
import com.example.bookstore.model.Category;

import java.math.BigDecimal;
import java.util.List;

public record BookResponse(Long id, String title, String isbn, BigDecimal price, int publishedYear,
                           Long authorId, String authorName, List<String> categories, Long version) {

    /** Must be called inside a transaction with author and categories fetched. */
    public static BookResponse from(Book book) {
        return new BookResponse(book.getId(), book.getTitle(), book.getIsbn(), book.getPrice(),
                book.getPublishedYear(), book.getAuthor().getId(), book.getAuthor().getName(),
                book.getCategories().stream().map(Category::getName).sorted().toList(),
                book.getVersion());
    }
}
~~~

~~~java src/main/java/com/example/bookstore/dto/AuthorRequest.java
package com.example.bookstore.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record AuthorRequest(@NotBlank @Size(max = 150) String name) {
}
~~~

~~~java src/main/java/com/example/bookstore/dto/AuthorResponse.java
package com.example.bookstore.dto;

import com.example.bookstore.model.Author;
import com.example.bookstore.model.Book;

import java.util.List;

public record AuthorResponse(Long id, String name, List<String> bookTitles) {

    public static AuthorResponse from(Author author) {
        return new AuthorResponse(author.getId(), author.getName(),
                author.getBooks().stream().map(Book::getTitle).sorted().toList());
    }
}
~~~

### Step 6: reproduce LazyInitializationException

Before writing the proper service, try the naive approach to see the failure with your own eyes. Temporarily add this to ^BookController^:

~~~java
@GetMapping("/{id}/naive")
public String naive(@PathVariable Long id) {
    Book book = bookRepository.findById(id).orElseThrow();   // transaction ends inside findById
    return book.getAuthor().getName();                         // proxy, no session -> boom
}
~~~

~~~text
org.hibernate.LazyInitializationException: Could not initialize proxy [com.example.bookstore.model.Author#1] - no session
~~~

With ^open-in-view: true^ this would "work" - hiding the problem. Delete the naive endpoint again.

### Step 7: reproduce the N+1 problem

A seemingly innocent service method:

~~~java
@Transactional(readOnly = true)
public PageResponse<BookResponse> findAllNaive(Pageable pageable) {
    return PageResponse.from(bookRepository.findAll(pageable), BookResponse::from);
}
~~~

^GET /api/books?size=6^ with 6 books by 4 authors logs:

~~~text
select b1_0.id, ... from books b1_0 order by b1_0.title offset ? rows fetch first ? rows only
select count(b1_0.id) from books b1_0
select a1_0.id, a1_0.name from authors a1_0 where a1_0.id=?
select c1_0.book_id, c1_1.id, c1_1.name from book_categories c1_0 join categories c1_1 on c1_1.id=c1_0.category_id where c1_0.book_id=?
select a1_0.id, a1_0.name from authors a1_0 where a1_0.id=?
select c1_0.book_id, c1_1.id, c1_1.name from book_categories c1_0 join categories c1_1 on c1_1.id=c1_0.category_id where c1_0.book_id=?
... (repeats for every book)
~~~

Two queries for the page, then one per distinct author and one per book for categories: **2 + 4 + 6 = 12 queries** for six books. A page of 100 would be about 200. Note that it did not throw - it was inside a transaction - which is exactly why N+1 sneaks into production.

To measure instead of eyeballing, enable Hibernate statistics temporarily:

~~~yaml src/main/resources/application.yml (temporary addition)
spring:
  jpa:
    properties:
      hibernate:
        generate_statistics: true
~~~

The log then prints ^12 JDBC statements executed^ per request.

### Step 8: the fixed BookService

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PageResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.model.Author;
import com.example.bookstore.model.Book;
import com.example.bookstore.model.Category;
import com.example.bookstore.repository.AuthorRepository;
import com.example.bookstore.repository.BookRepository;
import com.example.bookstore.repository.CategoryRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Objects;
import java.util.Set;

@Service
@Transactional(readOnly = true)
public class BookService {

    private final BookRepository bookRepository;
    private final AuthorRepository authorRepository;
    private final CategoryRepository categoryRepository;

    public BookService(BookRepository bookRepository,
                       AuthorRepository authorRepository,
                       CategoryRepository categoryRepository) {
        this.bookRepository = bookRepository;
        this.authorRepository = authorRepository;
        this.categoryRepository = categoryRepository;
    }

    /** 3 queries total, regardless of page size: page+author, count, categories. */
    public PageResponse<BookResponse> findAll(Pageable pageable) {
        Page<Book> page = bookRepository.findAllWithAuthor(pageable);
        if (page.hasContent()) {
            bookRepository.fetchCategories(page.getContent());   // initializes collections in this context
        }
        return PageResponse.from(page, BookResponse::from);
    }

    public BookResponse findById(Long id) {
        return bookRepository.findDetailedById(id)
                .map(BookResponse::from)
                .orElseThrow(() -> new BookNotFoundException("id " + id));
    }

    @Transactional
    public BookResponse create(BookRequest request) {
        if (bookRepository.existsByIsbn(request.isbn())) {
            throw new DuplicateIsbnException(request.isbn());
        }
        Author author = authorRepository.findById(request.authorId())
                .orElseThrow(() -> new IllegalArgumentException("Unknown author " + request.authorId()));
        Book book = new Book(request.title(), request.isbn(), request.price(), request.publishedYear());
        author.addBook(book);                       // sets book.author (owning side)
        resolveCategories(request.categoriesOrEmpty()).forEach(book::addCategory);
        return BookResponse.from(bookRepository.save(book));
    }

    @Transactional
    public BookResponse update(Long id, BookRequest request) {
        Book book = bookRepository.findDetailedById(id)
                .orElseThrow(() -> new BookNotFoundException("id " + id));
        if (request.version() == null || !Objects.equals(request.version(), book.getVersion())) {
            // Client edited a stale copy: reject instead of silently overwriting
            throw new ObjectOptimisticLockingFailureException(Book.class, id);
        }
        if (bookRepository.existsByIsbnAndIdNot(request.isbn(), id)) {
            throw new DuplicateIsbnException(request.isbn());
        }
        book.updateDetails(request.title(), request.isbn(), request.price(), request.publishedYear());

        Set<Category> wanted = resolveCategories(request.categoriesOrEmpty());
        Set.copyOf(book.getCategories()).stream()
                .filter(c -> !wanted.contains(c))
                .forEach(book::removeCategory);
        wanted.forEach(book::addCategory);

        bookRepository.flush();   // force UPDATE now so the new version is in the response
        return BookResponse.from(book);
    }

    @Transactional
    public void delete(Long id) {
        Book book = bookRepository.findDetailedById(id)
                .orElseThrow(() -> new BookNotFoundException("id " + id));
        book.getAuthor().removeBook(book);
        Set.copyOf(book.getCategories()).forEach(book::removeCategory);   // join rows deleted
        bookRepository.delete(book);
    }

    private Set<Category> resolveCategories(Set<String> names) {
        Set<Category> result = new java.util.HashSet<>();
        for (String name : names) {
            result.add(categoryRepository.findByNameIgnoreCase(name)
                    .orElseGet(() -> categoryRepository.save(new Category(name))));
        }
        return result;
    }
}
~~~

The unknown author case throws ^IllegalArgumentException^; add a handler mapping it to 400, or better, create an ^AuthorNotFoundException^ (an exercise below). The Lesson 3.2 search methods still exist; to avoid N+1 there, apply the same EntityGraph technique.

Now ^GET /api/books?size=6^ logs exactly:

~~~text
select b1_0.id, ..., a1_0.id, a1_0.name from books b1_0 join authors a1_0 on a1_0.id=b1_0.author_id order by b1_0.title offset ? rows fetch first ? rows only
select count(b1_0.id) from books b1_0
select distinct b1_0.id, ..., c1_1.id, c1_1.name from books b1_0 left join book_categories c1_0 on b1_0.id=c1_0.book_id left join categories c1_1 on c1_1.id=c1_0.category_id where b1_0.id in (?,?,?,?,?,?)
~~~

**3 queries for any page size** instead of about 2N. The second categories query works because both queries share the same persistence context: the identity guarantee from Lesson 3.1 means the books in the page are the same objects whose collections the second query initializes.

> A simpler global mitigation: ^spring.jpa.properties.hibernate.default_batch_fetch_size: 50^. Lazy loads are then batched into ^where id in (...)^ queries of up to 50 ids. It turns N+1 into 1 + N/50. Many teams enable it as a safety net and still write explicit fetches for hot endpoints.

### Step 9: AuthorService and controller

~~~java src/main/java/com/example/bookstore/service/AuthorService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.AuthorRequest;
import com.example.bookstore.dto.AuthorResponse;
import com.example.bookstore.model.Author;
import com.example.bookstore.repository.AuthorRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.NoSuchElementException;

@Service
@Transactional(readOnly = true)
public class AuthorService {

    private final AuthorRepository authorRepository;

    public AuthorService(AuthorRepository authorRepository) {
        this.authorRepository = authorRepository;
    }

    public AuthorResponse findById(Long id) {
        return authorRepository.findByIdWithBooks(id)        // one query, books join-fetched
                .map(AuthorResponse::from)
                .orElseThrow(() -> new NoSuchElementException("Author " + id + " not found"));
    }

    @Transactional
    public AuthorResponse create(AuthorRequest request) {
        return AuthorResponse.from(authorRepository.save(new Author(request.name())));
    }
}
~~~

~~~java src/main/java/com/example/bookstore/controller/AuthorController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.AuthorRequest;
import com.example.bookstore.dto.AuthorResponse;
import com.example.bookstore.service.AuthorService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;

@RestController
@RequestMapping("/api/authors")
public class AuthorController {

    private final AuthorService authorService;

    public AuthorController(AuthorService authorService) {
        this.authorService = authorService;
    }

    @GetMapping("/{id}")
    public AuthorResponse get(@PathVariable Long id) {
        return authorService.findById(id);
    }

    @PostMapping
    public ResponseEntity<AuthorResponse> create(@Valid @RequestBody AuthorRequest request) {
        AuthorResponse created = authorService.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }
}
~~~

^BookController^ from Lesson 3.2 needs no changes: it still delegates to ^BookService^ and returns DTOs. That is the payoff of clean layering.

### Step 10: map the new exceptions

Add to ^GlobalExceptionHandler^ (existing handlers unchanged):

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java (additions)
@ExceptionHandler(ObjectOptimisticLockingFailureException.class)
public ProblemDetail handleOptimisticLock(ObjectOptimisticLockingFailureException ex) {
    ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT,
            "The book was modified by someone else. Reload it and try again.");
    pd.setTitle("Concurrent modification");
    pd.setType(URI.create("https://api.example.com/problems/concurrent-modification"));
    return pd;
}

@ExceptionHandler(NoSuchElementException.class)
public ProblemDetail handleNoSuchElement(NoSuchElementException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
}

@ExceptionHandler(IllegalArgumentException.class)
public ProblemDetail handleIllegalArgument(IllegalArgumentException ex) {
    return ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
}
~~~

Required imports: ^org.springframework.orm.ObjectOptimisticLockingFailureException^ and ^java.util.NoSuchElementException^.

### Step 11: seed data and test

~~~java src/main/java/com/example/bookstore/config/DevDataSeeder.java
package com.example.bookstore.config;

import com.example.bookstore.model.Author;
import com.example.bookstore.model.Book;
import com.example.bookstore.model.Category;
import com.example.bookstore.repository.AuthorRepository;
import com.example.bookstore.repository.CategoryRepository;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.List;

@Component
@Profile("!postgres")
public class DevDataSeeder implements ApplicationRunner {

    private final AuthorRepository authorRepository;
    private final CategoryRepository categoryRepository;

    public DevDataSeeder(AuthorRepository authorRepository, CategoryRepository categoryRepository) {
        this.authorRepository = authorRepository;
        this.categoryRepository = categoryRepository;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        if (authorRepository.count() > 0) return;

        Category programming = categoryRepository.save(new Category("Programming"));
        Category architecture = categoryRepository.save(new Category("Architecture"));
        Category sciFi = categoryRepository.save(new Category("Science Fiction"));

        Author herbert = new Author("Frank Herbert");
        Book dune = new Book("Dune", "978-0441172719", new BigDecimal("9.99"), 1965);
        herbert.addBook(dune);
        dune.addCategory(sciFi);

        Author martin = new Author("Robert C. Martin");
        Book cleanCode = new Book("Clean Code", "978-0132350884", new BigDecimal("37.50"), 2008);
        Book cleanArch = new Book("Clean Architecture", "978-0134494166", new BigDecimal("34.99"), 2017);
        martin.addBook(cleanCode);
        martin.addBook(cleanArch);
        cleanCode.addCategory(programming);
        cleanArch.addCategory(programming);
        cleanArch.addCategory(architecture);

        Author bloch = new Author("Joshua Bloch");
        Book effectiveJava = new Book("Effective Java", "978-0134685991", new BigDecimal("44.99"), 2018);
        bloch.addBook(effectiveJava);
        effectiveJava.addCategory(programming);

        Author evans = new Author("Eric Evans");
        Book ddd = new Book("Domain-Driven Design", "978-0321125217", new BigDecimal("54.99"), 2003);
        evans.addBook(ddd);
        ddd.addCategory(architecture);
        ddd.addCategory(programming);

        // Cascade PERSIST from Author saves the books too
        authorRepository.saveAll(List.of(herbert, martin, bloch, evans));
    }
}
~~~

~~~powershell
.\mvnw spring-boot:run
curl http://localhost:8080/api/books/2
~~~

~~~json
{"id":2,"title":"Clean Code","isbn":"978-0132350884","price":37.50,"publishedYear":2008,
 "authorId":2,"authorName":"Robert C. Martin","categories":["Programming"],"version":0}
~~~

~~~powershell
curl http://localhost:8080/api/authors/2
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"The Clean Coder\",\"isbn\":\"978-0137081073\",\"price\":29.99,\"publishedYear\":2011,\"authorId\":2,\"categories\":[\"Programming\",\"Career\"]}"
~~~

The author endpoint returns ^{"id":2,"name":"Robert C. Martin","bookTitles":["Clean Architecture","Clean Code"]}^ in one query. The POST returns ^201 Created^ and creates the missing "Career" category on the fly.

### Step 12: prove optimistic locking

Send two updates that both claim to be based on version 0:

~~~powershell
curl -X PUT http://localhost:8080/api/books/2 -H "Content-Type: application/json" -d "{\"title\":\"Clean Code\",\"isbn\":\"978-0132350884\",\"price\":39.99,\"publishedYear\":2008,\"authorId\":2,\"categories\":[\"Programming\"],\"version\":0}"
curl -i -X PUT http://localhost:8080/api/books/2 -H "Content-Type: application/json" -d "{\"title\":\"Clean Code 2nd\",\"isbn\":\"978-0132350884\",\"price\":37.50,\"publishedYear\":2008,\"authorId\":2,\"categories\":[\"Programming\"],\"version\":0}"
~~~

The first returns ^"version":1^, and the SQL log shows the version check:

~~~text
update books set isbn=?, price=?, published_year=?, title=?, updated_at=?, version=? where id=? and version=?
~~~

The second returns:

~~~json
{
  "type": "https://api.example.com/problems/concurrent-modification",
  "title": "Concurrent modification",
  "status": 409,
  "detail": "The book was modified by someone else. Reload it and try again.",
  "instance": "/api/books/2"
}
~~~

The early comparison in the service catches stale clients; the ^where version = ?^ clause catches the truly simultaneous case where two transactions read version 1 at the same instant - one of them updates 0 rows and Hibernate throws.

### Step 13: see rollback rules in action

Add a temporary method to ^BookService^ and call it from a test endpoint:

~~~java
@Transactional
public void createThenFail(BookRequest request) throws java.io.IOException {
    create(request);                                  // self-call: joins the SAME transaction
    throw new java.io.IOException("checked!");        // checked -> Spring COMMITS by default
}
~~~

After calling it, the book **exists** in the database despite the exception. Change the annotation to ^@Transactional(rollbackFor = Exception.class)^ and repeat - now nothing is saved. (Note the self-call to ^create^ is fine here because we want the same transaction; if ^create^ had ^REQUIRES_NEW^, the self-invocation would silently ignore it.) Remove the method afterwards.

## 3. Common Pitfalls & Best Practices

- **Mistake:** updating only the inverse side (^author.getBooks().add(book)^) and wondering why ^author_id^ stays null. **Fix:** write to the owning side, and encapsulate both sides in helper methods like ^addBook^ / ^addCategory^.
- **Mistake:** leaving ^@ManyToOne^ at its EAGER default, or switching collections to EAGER to fix LazyInitializationException. **Fix:** make every association LAZY and fetch per use case with ^join fetch^, ^@EntityGraph^ or DTO projections.
- **Mistake:** enabling ^open-in-view^ so lazy loading works in controllers. **Fix:** keep it false, build DTOs inside the transactional service, and treat a LazyInitializationException as a signal that a fetch plan is missing.
- **Mistake:** not noticing N+1 because responses are correct. **Fix:** watch the SQL log or Hibernate statistics during development, write explicit fetch queries for list endpoints, and set ^default_batch_fetch_size^ as a safety net.
- **Mistake:** ^join fetch^ on a collection together with ^Pageable^ (in-memory paging warning). **Fix:** page with a to-one fetch, then load collections for the page ids in a second query or via batch fetching.
- **Mistake:** ^CascadeType.REMOVE^ or ^ALL^ on ^@ManyToMany^, or cascading where there is no real ownership. **Fix:** cascade only parent-to-child aggregates; for shared entities like categories, manage links explicitly.
- **Mistake:** expecting rollback on checked exceptions, or relying on ^@Transactional^ on private or self-invoked methods. **Fix:** use unchecked business exceptions or ^rollbackFor^, and move methods needing their own transaction into a separate bean.
- **Mistake:** last-write-wins updates on shared data. **Fix:** add ^@Version^, require the client to send the version it read, and return 409 on conflicts.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Authors, categories and N+1","tasks":["Add ^Author^ and ^Category^ with the mappings from the lesson, start the app and identify the ^book_categories^ join table and the ^fk_books_author^ constraint in the DDL log.","Implement the naive ^findAllNaive^ method, call ^GET /api/books?size=6^ and count the SQL statements; write the number down.","Replace it with the ^findAllWithAuthor^ plus ^fetchCategories^ approach and confirm the request now uses exactly 3 statements for any page size.","Reproduce the LazyInitializationException with the naive endpoint, then explain in one sentence why ^open-in-view: true^ would hide it.","Send two PUT requests with the same version and verify the second returns a 409 ProblemDetail."]},
{"title":"Exercise 2 (Challenge): Harden the domain","tasks":["Create an ^AuthorNotFoundException^ (404) and use it in ^BookService.create^ and ^AuthorService.findById^ instead of the generic exceptions.","Add ^GET /api/authors?page=0&size=10^ returning a ^PageResponse<AuthorSummary>^ with the number of books per author, using a JPQL constructor expression with ^count^ and ^group by^ (no N+1).","Implement an ^AuditLogService^ in a separate bean with ^@Transactional(propagation = Propagation.REQUIRES_NEW)^ that records every failed book creation, and prove the audit row survives the rollback of the outer transaction.","Enable ^hibernate.default_batch_fetch_size: 25^, revert to the naive list method, and compare the SQL log against the explicit fetch version.","Read the Spring Framework reference section 'Declarative Transaction Management' and summarize what happens when an inner REQUIRED method throws and the outer method catches the exception."]},
{"title":"Exercise 3 (Thinking): Design decisions","tasks":["Argue whether deleting an author should delete their books, be rejected with 409, or something else; describe how each option maps to cascade, orphanRemoval or service logic.","Explain why ^Set^ is preferred over ^List^ for the many-to-many collection and what SQL Hibernate generates when removing one element from a bag.","Draw (in text) the sequence of calls from the controller through the transaction proxy to the database for ^BookService.update^, including flush and the version check.","Compare optimistic locking with pessimistic locking (^@Lock(LockModeType.PESSIMISTIC_WRITE)^): give one scenario where each is the better choice."]}
]
};
