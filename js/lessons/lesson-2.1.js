LESSONS['2.1']={
md:String.raw`## 1. Concept & Theory

Welcome to Module 2. In Module 1 you learned what Spring Boot is, how auto-configuration works and how the IoC container wires beans together. Now we build something real: a **Bookstore API** that we will grow, lesson by lesson, all the way to a secured, tested, containerized production service.

> **Where the project stands:** this lesson creates a brand-new project called **bookstore**. Everything in this lesson is new. By the end you will have a running REST API with an in-memory ^BookService^ and a ^BookController^ that supports listing, reading, creating, updating and deleting books.

### 1.1 What is a REST API, really?

REST (Representational State Transfer) is an architectural style, not a library. In practice, a "REST API" in the Spring world means:

- **Resources** are nouns identified by URLs: ^/api/books^, ^/api/books/42^.
- **HTTP methods** are the verbs: GET reads, POST creates, PUT replaces, PATCH partially updates, DELETE removes.
- **Representations** are the data formats sent over the wire, almost always JSON (^application/json^).
- **Status codes** tell the client what happened: 200 OK, 201 Created, 204 No Content, 404 Not Found, and so on.
- **Statelessness**: every request carries everything the server needs. The server does not remember "the previous request" of the client.

**Real-world analogy:** think of a restaurant. The menu is your API documentation. The table number is the URL (^/tables/7^). The waiter is the HTTP protocol. "I would like to order" is POST, "what did I order?" is GET, "cancel my dessert" is DELETE. The kitchen (your service layer) does the real work, and the waiter comes back with a status: "here is your food" (200), "your order has been placed, ticket number 123" (201 with a Location), "sorry, we do not have that dish" (404).

### 1.2 Spring MVC: the engine behind @RestController

When you add ^spring-boot-starter-web^, you get **Spring MVC** running inside an embedded **Tomcat** server. Spring MVC is built around one central servlet: the **DispatcherServlet**. It is the "front controller": every single HTTP request to your app goes through it first.

Here is the full journey of a request like ^GET /api/books/1^:

~~~text
Client (curl / browser / mobile app)
   |
   v
Tomcat (embedded servlet container, listens on port 8080)
   |  parses raw TCP bytes into an HttpServletRequest
   v
Servlet Filters (encoding, security later in Module 4, etc.)
   |
   v
DispatcherServlet  (the front controller, auto-configured by Boot)
   |
   | 1. asks every HandlerMapping: "who handles GET /api/books/1 ?"
   |    -> RequestMappingHandlerMapping finds BookController#getBook(Long)
   |
   | 2. picks a HandlerAdapter that knows how to call that kind of handler
   |    -> RequestMappingHandlerAdapter
   |
   | 3. HandlerAdapter resolves method arguments
   |    (@PathVariable, @RequestParam, @RequestBody ...) using
   |    HandlerMethodArgumentResolvers and type conversion
   |
   | 4. invokes your controller method -> returns ResponseEntity<Book>
   |
   | 5. HandlerMethodReturnValueHandler sees @ResponseBody semantics,
   |    chooses an HttpMessageConverter based on the Accept header
   |    -> MappingJackson2HttpMessageConverter turns Book into JSON
   v
HTTP response: 200 OK, Content-Type: application/json, body {"id":1,...}
~~~

Let us zoom into each actor.

| Component | Role | Analogy |
|---|---|---|
| DispatcherServlet | Single entry point; orchestrates everything | The restaurant host who greets every guest |
| HandlerMapping | Maps a request (URL + method + headers) to a handler method | The seating chart: which waiter serves which table |
| HandlerAdapter | Knows how to actually invoke that handler | The waiter who knows how to talk to that specific chef |
| ArgumentResolver | Turns raw request pieces into typed Java parameters | Translating "table seven, no onions" into a ticket |
| HttpMessageConverter | Converts Java objects to and from bytes (JSON, XML, text) | The plating: turning ingredients into a presentable dish |
| Jackson ObjectMapper | The JSON library used by the JSON converter | The chef that knows the JSON recipe |

**The magic under the hood:** at startup, ^RequestMappingHandlerMapping^ scans every bean annotated with ^@Controller^ (and ^@RestController^, which is meta-annotated with ^@Controller^). For each method with a mapping annotation it builds a ^RequestMappingInfo^ (paths, HTTP methods, consumes, produces, params, headers) and stores it in a registry. That is why a typo in a path is not detected at compile time but you *will* see an error at startup if two methods claim exactly the same mapping ("Ambiguous mapping").

Spring Boot's ^WebMvcAutoConfiguration^ and ^DispatcherServletAutoConfiguration^ register all of this for you. In the pre-Boot days you wrote a ^web.xml^, declared the DispatcherServlet, configured view resolvers and message converters manually. Boot does it with sensible defaults, and you can still override any piece.

### 1.3 @Controller vs @RestController

- ^@Controller^ is for classic server-side MVC: methods return a **view name** (like ^"books/list"^) that a template engine (Thymeleaf) renders into HTML.
- ^@RestController^ is ^@Controller^ + ^@ResponseBody^. Every method's return value is written **directly into the response body** via an HttpMessageConverter. No views involved.

For APIs you will use ^@RestController^ 99% of the time.

### 1.4 HttpMessageConverters and Jackson

When your method returns a ^Book^ object, how does it become JSON? Spring MVC keeps an ordered list of ^HttpMessageConverter^ instances. For each response, it looks at:

1. The Java return type (here ^Book^).
2. The client's ^Accept^ header (for example ^application/json^, or ^*/*^ for "anything").
3. The ^produces^ attribute of your mapping, if any.

It then asks each converter "can you write a Book as application/json?". ^MappingJackson2HttpMessageConverter^ says yes, and uses Jackson's ^ObjectMapper^ to serialize the object. Jackson reads **record components** or **getters** to find the properties. Spring Boot auto-configures the ObjectMapper (via ^JacksonAutoConfiguration^) with production-friendly defaults, for example dates as ISO strings when the JSR-310 module is on the classpath (it is, by default).

If no converter can produce what the client asked for (say ^Accept: application/xml^ with no XML library), you get **406 Not Acceptable**. If the client sends a body in a format nobody can read, you get **415 Unsupported Media Type**. These are free behaviors you get from the framework, and they are correct HTTP semantics.

### 1.5 Request mapping annotations

| Annotation | Equivalent | Typical use |
|---|---|---|
| @RequestMapping("/api/books") on class | base path for all methods | Group endpoints of one resource |
| @GetMapping | @RequestMapping(method = GET) | Read one or many |
| @PostMapping | @RequestMapping(method = POST) | Create |
| @PutMapping | @RequestMapping(method = PUT) | Full replace |
| @PatchMapping | @RequestMapping(method = PATCH) | Partial update |
| @DeleteMapping | @RequestMapping(method = DELETE) | Remove |

^@RequestMapping^ without a ^method^ attribute on a **method** matches **all** HTTP methods. That is a classic security and correctness bug: a "read" endpoint accidentally accepting DELETE. Use the specific shortcut annotations on methods and keep ^@RequestMapping^ for the class-level base path.

### 1.6 @PathVariable vs @RequestParam

- **Path variables** identify a resource: ^/api/books/42^ means "the book with id 42". Use ^@PathVariable^.
- **Query parameters** filter, sort, paginate or tweak a collection: ^/api/books?author=tolkien&maxPrice=20^. Use ^@RequestParam^.

Rule of thumb: if removing the value makes the URL point to a **different resource**, it belongs in the path. If it only changes **which subset** or **how** you see it, it is a query parameter.

^@RequestParam^ details that matter in production:

- By default ^required = true^. A missing parameter results in **400 Bad Request** (^MissingServletRequestParameterException^).
- ^@RequestParam(required = false) String title^ gives you ^null^ when absent.
- ^@RequestParam(defaultValue = "0") int page^ implicitly makes it optional and supplies a default. Note the default is always written as a **String**; Spring converts it.
- ^Optional of String^ as parameter type also signals "optional".
- Type conversion is automatic: if the client sends ^?page=abc^ for an ^int^, Spring throws ^MethodArgumentTypeMismatchException^, which becomes **400**.

**Under the hood:** ^RequestParamMethodArgumentResolver^ and ^PathVariableMethodArgumentResolver^ read the raw string values, then delegate to Spring's ^ConversionService^ to convert them into ^Long^, ^int^, ^BigDecimal^, enums, dates and so on. Since Spring 6.1 you must compile with the ^-parameters^ flag for Spring to know parameter names without you writing ^@PathVariable("id")^. Spring Boot's Maven parent configures that for you automatically, which is one more reason to use the Boot parent POM.

### 1.7 ResponseEntity and status codes

Returning a plain object always yields **200 OK**. That is wrong for many operations. ^ResponseEntity^ lets you control status, headers and body.

| Operation | Success status | Body | Notes |
|---|---|---|---|
| GET collection | 200 OK | List (possibly empty) | Empty list is still 200, not 404 |
| GET single | 200 OK | The resource | 404 if not found |
| POST create | 201 Created | The created resource | Location header with new URL |
| PUT replace | 200 OK (or 204) | Updated resource | 404 if not found (or create, by design) |
| DELETE | 204 No Content | none | Idempotent: deleting twice is fine |
| Bad input | 400 Bad Request | Error details | Lesson 2.2 and 2.3 |

The **Location header** on a 201 tells the client where the new resource lives, for example ^Location: http://localhost:8080/api/books/3^. Well-behaved clients (and many API gateways and SDK generators) rely on it. Spring gives you ^ServletUriComponentsBuilder^ to build it from the current request, so it works correctly behind different hosts and ports.

### 1.8 Idempotency and safety

| Method | Safe (no side effects) | Idempotent (repeat = same result) |
|---|---|---|
| GET | Yes | Yes |
| HEAD | Yes | Yes |
| PUT | No | Yes |
| DELETE | No | Yes |
| POST | No | No |
| PATCH | No | Not guaranteed |

Why should you care? Networks fail. Load balancers, proxies and HTTP clients **retry** requests. If a client retries a PUT ("set book 3 to this state") nothing bad happens. If it retries a POST, you may create two orders and charge a customer twice. In production, this is why payment APIs (Stripe, Adyen) support an **Idempotency-Key** header for POST. Design your methods so that GET never changes data and PUT/DELETE are truly idempotent.

### 1.9 REST naming conventions

- Use **plural nouns**: ^/api/books^, not ^/api/getBooks^ or ^/api/book^.
- Use **lowercase and hyphens**: ^/api/book-reviews^.
- Nest only for real ownership, max one level: ^/api/authors/5/books^.
- No verbs in paths: the HTTP method is the verb. Exception: true actions that are not CRUD, like ^POST /api/orders/7/cancel^.
- Version your API, typically via a path prefix ^/api/v1^ or a header. We keep ^/api/books^ for simplicity in this course.
- Filters, sorting and pagination as query parameters: ^?sort=title,asc&page=0&size=20^.

---

## 2. Code Walkthrough

### 2.1 Generate the project

Go to start.spring.io (or use IntelliJ's Spring Initializr wizard) with:

- Project: Maven, Language: Java, Spring Boot: 3.4.x
- Group: ^com.example^, Artifact: ^bookstore^, Package name: ^com.example.bookstore^
- Packaging: Jar, Java: 21
- Dependencies: **Spring Web**, **Validation**, **Spring Boot Actuator**, **Spring Boot DevTools**

Validation is not used heavily until Lesson 2.2, but we add it now so the project is ready.

### 2.2 The pom.xml

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
    <description>Bookstore API - Spring Boot 0 to Hero</description>

    <properties>
        <java.version>21</java.version>
    </properties>

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

Notes: ^spring-boot-starter-web^ pulls in Spring MVC, embedded Tomcat and Jackson. DevTools is marked ^optional^ and ^runtime^, so it is never packaged into production jars by accident in a way that is used (Boot disables it when running from a fully packaged jar).

### 2.3 Application entry point

~~~java src/main/java/com/example/bookstore/BookstoreApplication.java
package com.example.bookstore;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class BookstoreApplication {

    public static void main(String[] args) {
        SpringApplication.run(BookstoreApplication.class, args);
    }
}
~~~

Remember from Module 1: ^@SpringBootApplication^ enables component scanning starting at ^com.example.bookstore^. All our sub-packages (^controller^, ^service^, ^model^...) are beneath it, so they are found automatically.

### 2.4 Configuration

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: bookstore

server:
  port: 8080

management:
  endpoints:
    web:
      exposure:
        include: health,info,mappings
~~~

We expose the ^mappings^ actuator endpoint so you can **see** what the HandlerMapping registered: ^GET /actuator/mappings^. That is a fantastic learning and debugging tool. In production, you would restrict actuator exposure (we do that in Module 6).

### 2.5 The model

For now, ^Book^ is a simple Java **record**: immutable, with ^equals^, ^hashCode^ and ^toString^ for free. In Lesson 3.1 it becomes a JPA entity (a class), and in Lesson 2.2 we stop exposing it directly through the API.

~~~java src/main/java/com/example/bookstore/model/Book.java
package com.example.bookstore.model;

import java.math.BigDecimal;

public record Book(
        Long id,
        String title,
        String isbn,
        BigDecimal price,
        int publishedYear
) {
    public Book withId(Long newId) {
        return new Book(newId, title, isbn, price, publishedYear);
    }
}
~~~

Why ^BigDecimal^ for price? Because ^double^ cannot represent 0.1 exactly. ^0.1 + 0.2^ in floating point is ^0.30000000000000004^. With money, those rounding errors become real accounting bugs. Always use ^BigDecimal^ (or integer cents) for currency.

### 2.6 The in-memory service

The service owns business logic and data access. The controller should be thin: translate HTTP into method calls and results back into HTTP. Keeping that separation now makes the switch to a real database in Module 3 painless: only the service internals change.

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.model.Book;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class BookService {

    private final Map<Long, Book> books = new ConcurrentHashMap<>();
    private final AtomicLong idSequence = new AtomicLong();

    public BookService() {
        create(new Book(null, "Clean Code", "9780132350884", new BigDecimal("37.99"), 2008));
        create(new Book(null, "Effective Java", "9780134685991", new BigDecimal("45.50"), 2018));
        create(new Book(null, "Spring in Action", "9781617297571", new BigDecimal("49.99"), 2022));
    }

    public List<Book> findAll(String titleFilter, BigDecimal maxPrice) {
        return books.values().stream()
                .filter(b -> titleFilter == null
                        || b.title().toLowerCase().contains(titleFilter.toLowerCase()))
                .filter(b -> maxPrice == null || b.price().compareTo(maxPrice) <= 0)
                .sorted(Comparator.comparing(Book::id))
                .toList();
    }

    public Optional<Book> findById(Long id) {
        return Optional.ofNullable(books.get(id));
    }

    public Book create(Book book) {
        long id = idSequence.incrementAndGet();
        Book saved = book.withId(id);
        books.put(id, saved);
        return saved;
    }

    public Optional<Book> update(Long id, Book book) {
        if (!books.containsKey(id)) {
            return Optional.empty();
        }
        Book updated = book.withId(id);
        books.put(id, updated);
        return Optional.of(updated);
    }

    public boolean delete(Long id) {
        return books.remove(id) != null;
    }
}
~~~

Why ^ConcurrentHashMap^ and ^AtomicLong^? Because a Spring ^@Service^ is a **singleton** shared by all request threads. Tomcat serves requests on a pool of threads (200 by default). A plain ^HashMap^ with a ^long^ counter would produce lost updates and duplicate ids under concurrent load. This is a real production lesson: **singleton beans must be thread-safe**. Stateless beans are automatically thread-safe; stateful ones need concurrent data structures.

Note that we return ^Optional^ from lookups instead of ^null^, and a ^boolean^ from delete. The controller decides how "not found" maps to HTTP. In Lesson 2.3 we will replace this with a ^BookNotFoundException^ handled globally, which is cleaner.

### 2.7 The controller

~~~java src/main/java/com/example/bookstore/controller/BookController.java
package com.example.bookstore.controller;

import com.example.bookstore.model.Book;
import com.example.bookstore.service.BookService;
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

    // GET /api/books?title=java&maxPrice=50
    @GetMapping
    public List<Book> getBooks(
            @RequestParam(required = false) String title,
            @RequestParam(required = false) BigDecimal maxPrice) {
        return bookService.findAll(title, maxPrice);
    }

    // GET /api/books/1
    @GetMapping("/{id}")
    public ResponseEntity<Book> getBook(@PathVariable Long id) {
        return bookService.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // POST /api/books
    @PostMapping
    public ResponseEntity<Book> createBook(@RequestBody Book book) {
        Book created = bookService.create(book);
        URI location = ServletUriComponentsBuilder
                .fromCurrentRequest()
                .path("/{id}")
                .buildAndExpand(created.id())
                .toUri();
        return ResponseEntity.created(location).body(created);
    }

    // PUT /api/books/1
    @PutMapping("/{id}")
    public ResponseEntity<Book> updateBook(@PathVariable Long id, @RequestBody Book book) {
        return bookService.update(id, book)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    // DELETE /api/books/1
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteBook(@PathVariable Long id) {
        bookService.delete(id);
        return ResponseEntity.noContent().build();
    }

    // GET /api/books/paged?page=0&size=2  (demonstrates defaults)
    @GetMapping("/paged")
    public List<Book> getBooksPaged(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size) {
        return bookService.findAll(null, null).stream()
                .skip((long) page * size)
                .limit(size)
                .toList();
    }
}
~~~

Step by step:

1. ^@RestController^ registers the class as a bean (it is a ^@Component^) and enables ^@ResponseBody^ for all methods.
2. ^@RequestMapping("/api/books")^ sets the base path. All method paths are relative to it.
3. **Constructor injection**: a single constructor means no ^@Autowired^ needed. The field is ^final^, so the controller is immutable and trivially testable with a plain ^new BookController(fakeService)^.
4. ^getBooks^ returns a ^List^ directly. That always means 200, which is right for collections, even empty ones.
5. ^getBook^ maps the ^Optional^: present becomes 200 with body, empty becomes 404 with no body.
6. ^createBook^ builds the Location header from the current request URL (^/api/books^) plus ^/{id}^ and returns 201. Note: ^{id}^ here is a URI template variable for the builder, not a Spring property placeholder.
7. ^deleteBook^ always returns 204, even when the book does not exist. That is a deliberate choice that keeps DELETE idempotent from the client's point of view. Returning 404 on a second delete is also acceptable; pick one convention and document it. We will revisit this in 2.3.
8. ^/paged^ shows ^defaultValue^. Notice the literal path ^/paged^ does not clash with ^/{id}^: Spring ranks more specific patterns (literal segments) higher than patterns with variables.

**A caveat we fix in Lesson 2.2:** we accept and return the ^Book^ model directly, including the client-provided ^id^ (which we ignore). That couples API and internal model. It is fine for a first lesson; it is not fine in production.

### 2.8 Run it

~~~powershell
./mvnw spring-boot:run
~~~

On Windows ^cmd^ use ^mvnw.cmd spring-boot:run^. In the log look for:

~~~text
Tomcat initialized with port 8080 (http)
Started BookstoreApplication in 1.9 seconds
~~~

### 2.9 Test with curl

~~~text
curl -i http://localhost:8080/api/books
~~~

Expected (headers shortened):

~~~text
HTTP/1.1 200
Content-Type: application/json

[{"id":1,"title":"Clean Code","isbn":"9780132350884","price":37.99,"publishedYear":2008},
 {"id":2,"title":"Effective Java","isbn":"9780134685991","price":45.50,"publishedYear":2018},
 {"id":3,"title":"Spring in Action","isbn":"9781617297571","price":49.99,"publishedYear":2022}]
~~~

Filtering with query parameters:

~~~text
curl -i "http://localhost:8080/api/books?title=java&maxPrice=46"
~~~

Returns only "Effective Java". Single resource and a missing one:

~~~text
curl -i http://localhost:8080/api/books/2
curl -i http://localhost:8080/api/books/999
~~~

The second returns ^HTTP/1.1 404^ with an empty body. Create a book:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"Domain-Driven Design\",\"isbn\":\"9780321125217\",\"price\":59.00,\"publishedYear\":2003}"
~~~

Expected:

~~~text
HTTP/1.1 201
Location: http://localhost:8080/api/books/4
Content-Type: application/json

{"id":4,"title":"Domain-Driven Design","isbn":"9780321125217","price":59.00,"publishedYear":2003}
~~~

Delete and verify:

~~~text
curl -i -X DELETE http://localhost:8080/api/books/4
curl -i http://localhost:8080/api/books/4
~~~

First gives 204, second gives 404. Type mismatch:

~~~text
curl -i http://localhost:8080/api/books/abc
~~~

Gives 400 because ^abc^ cannot be converted to ^Long^. Spring Boot's default error JSON shows ^"status":400,"error":"Bad Request"^. We will make these errors beautiful and consistent in Lesson 2.3.

### 2.10 Test with PowerShell

On Windows, PowerShell's ^curl^ used to be an alias of ^Invoke-WebRequest^, which confuses many people. Use ^curl.exe^ explicitly, or better, the native ^Invoke-RestMethod^, which parses JSON into objects for you:

~~~powershell
# List all books (parsed into PowerShell objects, shown as a table)
Invoke-RestMethod -Uri http://localhost:8080/api/books | Format-Table

# Get one
Invoke-RestMethod -Uri http://localhost:8080/api/books/1

# Create one
$body = @{
    title         = "Refactoring"
    isbn          = "9780134757599"
    price         = 47.99
    publishedYear = 2018
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/books -ContentType "application/json" -Body $body

# See status code and headers (Location) with Invoke-WebRequest
$response = Invoke-WebRequest -Method Post -Uri http://localhost:8080/api/books -ContentType "application/json" -Body $body
$response.StatusCode
$response.Headers["Location"]

# Delete
Invoke-RestMethod -Method Delete -Uri http://localhost:8080/api/books/1
~~~

Note: ^Invoke-RestMethod^ throws an error on 4xx/5xx responses. In PowerShell 7 you can add ^-SkipHttpErrorCheck^ to inspect error responses instead.

### 2.11 Peek under the hood with Actuator

~~~text
curl http://localhost:8080/actuator/mappings
~~~

Search the JSON for ^BookController^. You will see entries like ^{GET [/api/books/{id}]}^ with the handler method name. That is literally the registry that ^RequestMappingHandlerMapping^ built at startup. You can also set ^logging.level.org.springframework.web=DEBUG^ in ^application.yml^ and watch the DispatcherServlet log every mapping decision and converter choice per request. Try it once; it demystifies a lot.

### 2.12 Files in this lesson

| File | Status |
|---|---|
| pom.xml | New |
| src/main/resources/application.yml | New |
| BookstoreApplication.java | New |
| model/Book.java | New |
| service/BookService.java | New |
| controller/BookController.java | New |

---

## 3. Common Pitfalls & Best Practices

- **Using @RequestMapping without a method on handler methods.** It matches GET, POST, DELETE... all at once. Fix: use ^@GetMapping^, ^@PostMapping^ etc. on methods; keep ^@RequestMapping^ for the class-level base path.
- **Returning 200 for everything.** Creation should return 201 with a Location header, deletion 204, missing resources 404. Fix: return ^ResponseEntity^ and use ^created()^, ^noContent()^, ^notFound()^.
- **Returning 404 for an empty collection.** A search with no results is a successful search. Fix: return 200 with ^[]^.
- **Putting business logic in the controller.** It becomes untestable and duplicates logic across endpoints. Fix: thin controllers that delegate to a ^@Service^.
- **Non-thread-safe state in singleton beans.** A ^HashMap^ plus ^long^ counter in a service will corrupt under load. Fix: keep beans stateless, or use ^ConcurrentHashMap^ and ^AtomicLong^ (and later, a database).
- **Using double for money.** Rounding errors in prices and totals. Fix: ^BigDecimal^ created from strings, e.g. ^new BigDecimal("19.99")^.
- **Verbs in URLs and singular nouns.** ^/getBook?id=1^ is RPC, not REST. Fix: ^GET /api/books/1^.
- **Making GET change state.** Crawlers, prefetchers and retries will trigger it. Fix: GET must be safe; use POST/PUT/DELETE for changes.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Extend the BookController","tasks":["Add a query parameter ^minYear^ (optional, Integer) to ^GET /api/books^ and filter books published in or after that year inside ^BookService^.","Add an endpoint ^GET /api/books/isbn/{isbn}^ that returns 200 with the book or 404 if no book has that ISBN.","Add ^GET /api/books/count^ that returns a JSON object like {\"count\": 3}. Make sure it does not clash with ^/{id}^ and explain why.","Test all three endpoints with both curl and ^Invoke-RestMethod^, and confirm the status codes with ^curl -i^."]},
{"title":"Exercise 2 (Challenge): PATCH and sorting","tasks":["Implement ^PATCH /api/books/{id}^ that only updates the price. Accept a small JSON body with a ^price^ field (create a tiny record for it). Return 200 with the updated book or 404.","Add ^sort^ and ^direction^ query parameters to ^GET /api/books^ with defaults ^id^ and ^asc^. Support sorting by ^title^, ^price^ and ^publishedYear^.","Decide what should happen if the client sends ^sort=banana^ and implement it (hint: 400 is appropriate; for now you may use ^ResponseEntity.badRequest()^).","Read the Spring Framework reference section on Annotated Controllers, Request Mapping, and explain in two sentences what the ^produces^ and ^consumes^ attributes do and which status codes result when they do not match."]},
{"title":"Exercise 3 (Thinking): HTTP semantics in production","tasks":["A mobile client times out on ^POST /api/books^ and retries automatically. Describe what happens in our current API and propose a design using an ^Idempotency-Key^ header to prevent duplicates.","Is our ^DELETE^ that always returns 204 idempotent? Argue for and against returning 404 on the second delete.","Enable ^logging.level.org.springframework.web=DEBUG^, call ^GET /api/books/1^ with ^Accept: application/xml^ and explain from the logs why you get 406.","Look at ^/actuator/mappings^ and find the entry for your PATCH endpoint. Which handler mapping registered it?"]}
]
};
