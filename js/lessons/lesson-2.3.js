LESSONS['2.3']={
md:String.raw`## 1. Concept & Theory

> **Where the project stands:** after Lesson 2.2 the **bookstore** API uses ^BookRequest^ / ^BookResponse^ records, a ^BookMapper^, Bean Validation (including the custom ^@ValidIsbn^), and validated path and query parameters. But error handling is scattered: every controller method maps ^Optional.empty()^ to 404 by hand, and invalid requests return Spring Boot's generic error JSON with no field details. In this lesson we centralize error handling. New files: ^exception/BookNotFoundException.java^, ^exception/DuplicateIsbnException.java^, ^exception/ErrorCode.java^, ^exception/GlobalExceptionHandler.java^. Changed files: ^BookService.java^, ^BookController.java^, ^application.yml^.

### 1.1 The problem with ad-hoc error handling

Without a strategy, real APIs end up with:

- Some endpoints returning ^{"error":"not found"}^, others ^{"message":"Book missing"}^, others an empty 404.
- Stack traces leaking to clients (revealing framework versions, class names, SQL, sometimes credentials in exception messages). This is OWASP "Security Misconfiguration" territory.
- Duplicated try/catch blocks in every controller.
- Clients (frontends, partner integrations) that cannot reliably parse errors, so they show "Something went wrong" for everything.

**Analogy:** imagine a hotel where every employee reports problems differently: one shouts, one writes a note, one says nothing. A professional hotel has **one front desk** with a standard incident form. ^@RestControllerAdvice^ is that front desk; **ProblemDetail** is the standard form.

### 1.2 RFC 9457 (formerly RFC 7807): Problem Details for HTTP APIs

RFC 7807 (2016), superseded by **RFC 9457** (2023, backward compatible), defines a standard JSON error format with media type ^application/problem+json^:

| Member | Meaning | Example |
|---|---|---|
| type | URI identifying the problem type (documentation link) | https://api.bookstore.example/problems/book-not-found |
| title | Short, human-readable summary of the problem type | Book not found |
| status | The HTTP status code | 404 |
| detail | Human-readable explanation of this occurrence | Book with id 42 does not exist |
| instance | URI of this specific occurrence | /api/books/42 |
| (extensions) | Any extra members you define | errorCode, timestamp, errors |

Benefits: a standard any client library can parse, room for your own extension fields, and you get it nearly for free in Spring 6 / Boot 3.

### 1.3 Spring's building blocks

| Building block | What it does |
|---|---|
| @ExceptionHandler | Method that handles given exception types. In a controller it applies to that controller only |
| @ControllerAdvice | Makes @ExceptionHandler (and @InitBinder, @ModelAttribute) methods global across controllers |
| @RestControllerAdvice | @ControllerAdvice + @ResponseBody; return values are written as the body |
| ProblemDetail | Spring 6 class representing an RFC 9457 body, with setProperty for extensions |
| ErrorResponse | Interface for exceptions that carry status + ProblemDetail (e.g. ResponseStatusException) |
| ErrorResponseException | Base class for your own exceptions that are already ProblemDetail-aware |
| ResponseEntityExceptionHandler | Base class with handlers for ALL standard Spring MVC exceptions, producing ProblemDetail |

### 1.4 How exceptions travel under the hood

When your controller (or anything it calls) throws, the exception propagates up to the ^DispatcherServlet^, which asks its list of ^HandlerExceptionResolver^ beans, in order:

1. **ExceptionHandlerExceptionResolver** looks for a matching ^@ExceptionHandler^: first in the controller class itself, then in ^@ControllerAdvice^ beans (ordered by ^@Order^). It picks the **closest match by exception type hierarchy**: a handler for ^BookNotFoundException^ wins over one for ^RuntimeException^, which wins over ^Exception^.
2. **ResponseStatusExceptionResolver** handles exceptions annotated with ^@ResponseStatus^ and ^ResponseStatusException^.
3. **DefaultHandlerExceptionResolver** maps standard Spring exceptions to status codes (that is where the 400 / 415 / 405 you saw in 2.2 come from).

If nobody resolves it, the exception goes back to the servlet container, which forwards to ^/error^, served by Spring Boot's ^BasicErrorController^: the generic ^timestamp/status/error/path^ JSON. That is the fallback we want to avoid relying on.

### 1.5 spring.mvc.problemdetails.enabled

Setting ^spring.mvc.problemdetails.enabled=true^ makes Boot register a ^@ControllerAdvice^ that extends ^ResponseEntityExceptionHandler^, so **all standard MVC exceptions** (415, 405, 400 for unreadable bodies, validation...) render as ^application/problem+json^. That is a great default. **However**, the auto-configured advice is only created if **you have no** ^ResponseEntityExceptionHandler^ bean yourself (^@ConditionalOnMissingBean^). Since we will write our own handler extending ^ResponseEntityExceptionHandler^, ours replaces it. We keep the property enabled anyway, so the behavior stays consistent if the handler is ever removed, and it documents intent.

### 1.6 Designing exceptions and error codes

Good production practice:

- **Domain exceptions** express business situations: ^BookNotFoundException^, ^DuplicateIsbnException^. They are unchecked (extend ^RuntimeException^) so they do not pollute signatures, and they live in the ^exception^ package.
- The **service** throws them; it knows nothing about HTTP. The **advice** translates them to HTTP. This keeps the service reusable (from a message listener, a scheduled job, a CLI).
- **Stable error codes** (e.g. ^BOOK_NOT_FOUND^, ^VALIDATION_FAILED^) are part of your API contract. Clients branch on codes, never on human-readable messages, which you may want to change or translate.
- **Never leak internals.** The catch-all handler returns a generic message plus a **correlation id**; the full stack trace goes to the **logs** only, tagged with the same id. Support can then find the log entry from the id the customer reports.
- **Log levels by category**: 4xx client errors are usually ^WARN^ or ^DEBUG^ without stack traces (they are not your bug and would flood logs); 5xx are ^ERROR^ with full stack traces.

| Situation | Status | errorCode |
|---|---|---|
| Book id does not exist | 404 | BOOK_NOT_FOUND |
| ISBN already used | 409 Conflict | DUPLICATE_ISBN |
| Body fields invalid | 400 | VALIDATION_FAILED |
| Path/query param invalid | 400 | VALIDATION_FAILED |
| Malformed JSON | 400 | MALFORMED_REQUEST |
| Unexpected bug | 500 | INTERNAL_ERROR |

---

## 2. Code Walkthrough

### 2.1 Configuration

~~~yaml src/main/resources/application.yml
spring:
  application:
    name: bookstore
  mvc:
    problemdetails:
      enabled: true

server:
  port: 8080
  error:
    include-stacktrace: never
    include-message: never

management:
  endpoints:
    web:
      exposure:
        include: health,info,mappings
~~~

^include-stacktrace: never^ and ^include-message: never^ are the defaults for the fallback ^/error^ page, but stating them explicitly protects you from a teammate flipping them "temporarily" in production.

### 2.2 Error codes

~~~java src/main/java/com/example/bookstore/exception/ErrorCode.java
package com.example.bookstore.exception;

import org.springframework.http.HttpStatus;

public enum ErrorCode {

    BOOK_NOT_FOUND(HttpStatus.NOT_FOUND, "Book not found"),
    DUPLICATE_ISBN(HttpStatus.CONFLICT, "Duplicate ISBN"),
    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, "Validation failed"),
    MALFORMED_REQUEST(HttpStatus.BAD_REQUEST, "Malformed request"),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error");

    private final HttpStatus status;
    private final String title;

    ErrorCode(HttpStatus status, String title) {
        this.status = status;
        this.title = title;
    }

    public HttpStatus status() {
        return status;
    }

    public String title() {
        return title;
    }

    public String slug() {
        return name().toLowerCase().replace('_', '-');
    }
}
~~~

### 2.3 Domain exceptions

~~~java src/main/java/com/example/bookstore/exception/BookstoreException.java
package com.example.bookstore.exception;

public abstract class BookstoreException extends RuntimeException {

    private final ErrorCode errorCode;

    protected BookstoreException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public ErrorCode getErrorCode() {
        return errorCode;
    }
}
~~~

~~~java src/main/java/com/example/bookstore/exception/BookNotFoundException.java
package com.example.bookstore.exception;

public class BookNotFoundException extends BookstoreException {

    public BookNotFoundException(Long id) {
        super(ErrorCode.BOOK_NOT_FOUND, "Book with id " + id + " does not exist");
    }
}
~~~

~~~java src/main/java/com/example/bookstore/exception/DuplicateIsbnException.java
package com.example.bookstore.exception;

public class DuplicateIsbnException extends BookstoreException {

    public DuplicateIsbnException(String isbn) {
        super(ErrorCode.DUPLICATE_ISBN, "A book with ISBN " + isbn + " already exists");
    }
}
~~~

A common abstract base (^BookstoreException^) lets one handler cover all domain exceptions, while each subclass carries its own code. Adding a new business error later is a two-line class plus an enum constant; no handler change.

### 2.4 The global exception handler

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
package com.example.bookstore.exception;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.net.URI;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private static final String TYPE_BASE = "https://api.bookstore.example/problems/";

    // ---------- Domain exceptions (404, 409, ...) ----------

    @ExceptionHandler(BookstoreException.class)
    public ProblemDetail handleBookstoreException(BookstoreException ex, HttpServletRequest request) {
        ErrorCode code = ex.getErrorCode();
        log.warn("Business error {} on {} {}: {}",
                code, request.getMethod(), request.getRequestURI(), ex.getMessage());
        return problem(code, ex.getMessage(), request.getRequestURI());
    }

    // ---------- @Valid @RequestBody failures ----------

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(
            MethodArgumentNotValidException ex,
            HttpHeaders headers,
            HttpStatusCode status,
            WebRequest request) {

        List<Map<String, Object>> fieldErrors = ex.getBindingResult().getFieldErrors().stream()
                .map(this::toFieldError)
                .toList();

        List<String> globalErrors = ex.getBindingResult().getGlobalErrors().stream()
                .map(error -> error.getDefaultMessage())
                .toList();

        ProblemDetail body = problem(ErrorCode.VALIDATION_FAILED,
                "Request body has " + ex.getErrorCount() + " invalid field(s)",
                path(request));
        body.setProperty("errors", fieldErrors);
        if (!globalErrors.isEmpty()) {
            body.setProperty("globalErrors", globalErrors);
        }

        log.debug("Validation failed on {}: {}", path(request), fieldErrors);
        return ResponseEntity.badRequest().body(body);
    }

    // ---------- Constraints on @PathVariable / @RequestParam (Spring 6.1+) ----------

    @Override
    protected ResponseEntity<Object> handleHandlerMethodValidationException(
            HandlerMethodValidationException ex,
            HttpHeaders headers,
            HttpStatusCode status,
            WebRequest request) {

        List<Map<String, Object>> paramErrors = ex.getParameterValidationResults().stream()
                .flatMap(result -> result.getResolvableErrors().stream()
                        .map(error -> Map.<String, Object>of(
                                "field", result.getMethodParameter().getParameterName(),
                                "message", String.valueOf(error.getDefaultMessage()))))
                .toList();

        ProblemDetail body = problem(ErrorCode.VALIDATION_FAILED,
                "One or more request parameters are invalid", path(request));
        body.setProperty("errors", paramErrors);
        return ResponseEntity.badRequest().body(body);
    }

    // ---------- Malformed JSON ----------

    @Override
    protected ResponseEntity<Object> handleHttpMessageNotReadable(
            HttpMessageNotReadableException ex,
            HttpHeaders headers,
            HttpStatusCode status,
            WebRequest request) {

        log.debug("Unreadable request body on {}: {}", path(request), ex.getMessage());
        ProblemDetail body = problem(ErrorCode.MALFORMED_REQUEST,
                "Request body is missing or is not valid JSON", path(request));
        return ResponseEntity.badRequest().body(body);
    }

    // ---------- Catch-all: never leak internals ----------

    @ExceptionHandler(Exception.class)
    public ProblemDetail handleUnexpected(Exception ex, HttpServletRequest request) {
        String errorId = UUID.randomUUID().toString();
        log.error("Unexpected error [errorId={}] on {} {}",
                errorId, request.getMethod(), request.getRequestURI(), ex);

        ProblemDetail body = problem(ErrorCode.INTERNAL_ERROR,
                "An unexpected error occurred. Please contact support with the errorId.",
                request.getRequestURI());
        body.setProperty("errorId", errorId);
        return body;
    }

    // ---------- Helpers ----------

    private ProblemDetail problem(ErrorCode code, String detail, String instance) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(code.status(), detail);
        pd.setType(URI.create(TYPE_BASE + code.slug()));
        pd.setTitle(code.title());
        pd.setInstance(URI.create(instance));
        pd.setProperty("errorCode", code.name());
        pd.setProperty("timestamp", Instant.now());
        return pd;
    }

    private Map<String, Object> toFieldError(FieldError error) {
        return Map.of(
                "field", error.getField(),
                "message", String.valueOf(error.getDefaultMessage()),
                "code", String.valueOf(error.getCode()));
    }

    private String path(WebRequest request) {
        return request.getDescription(false).replace("uri=", "");
    }
}
~~~

Walkthrough:

1. **Extending ResponseEntityExceptionHandler** gives us ProblemDetail responses for ~20 standard Spring MVC exceptions (405, 406, 415, missing params, type mismatches...). We **override** only the ones we want to customize. Important: you must not declare your own ^@ExceptionHandler(MethodArgumentNotValidException.class)^ when extending this class; it already handles that type, and Spring fails at startup with "Ambiguous @ExceptionHandler method". Override the protected method instead.
2. **handleBookstoreException** covers every domain exception through the base class. Returning ^ProblemDetail^ directly is enough: Spring reads its ^status^ for the HTTP status and writes it as ^application/problem+json^.
3. **handleMethodArgumentNotValid** turns the ^BindingResult^ into a clean ^errors^ array: field, message, and constraint code. We deliberately **do not** echo the rejected value: it may contain sensitive data (think passwords or card numbers in other DTOs).
4. **handleHandlerMethodValidationException** does the same for ^@Positive Long id^ style parameter constraints.
5. **handleUnexpected** is the safety net. The client gets a generic message and an ^errorId^; the log gets the full stack trace (passing ^ex^ as the **last** argument to SLF4J, with no placeholder for it, makes SLF4J print the stack trace).
6. **Logging levels**: business errors at WARN, validation at DEBUG, the unexpected at ERROR. In Module 6 we add MDC request ids so every log line of a request is correlated automatically.

**Why the catch-all does not swallow 404/405:** handler matching is by closest type. Standard MVC exceptions are matched by ^ResponseEntityExceptionHandler^'s own, more specific ^@ExceptionHandler^ declaration, so they never reach ^Exception.class^. One caveat: Spring Security exceptions (^AccessDeniedException^) in Module 4 would be caught by a catch-all in an advice if thrown inside a controller method; we will handle that explicitly then.

### 2.5 The service throws domain exceptions

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.BookMapper;
import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.exception.BookNotFoundException;
import com.example.bookstore.exception.DuplicateIsbnException;
import com.example.bookstore.model.Book;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class BookService {

    private final Map<Long, Book> books = new ConcurrentHashMap<>();
    private final AtomicLong idSequence = new AtomicLong();

    public BookService() {
        save(new Book(null, "Clean Code", "9780132350884", new BigDecimal("37.99"), 2008));
        save(new Book(null, "Effective Java", "9780134685991", new BigDecimal("45.50"), 2018));
        save(new Book(null, "Spring in Action", "9781617297571", new BigDecimal("49.99"), 2022));
    }

    public List<BookResponse> findAll(String titleFilter, BigDecimal maxPrice) {
        return books.values().stream()
                .filter(b -> titleFilter == null
                        || b.title().toLowerCase().contains(titleFilter.toLowerCase()))
                .filter(b -> maxPrice == null || b.price().compareTo(maxPrice) <= 0)
                .sorted(Comparator.comparing(Book::id))
                .map(BookMapper::toResponse)
                .toList();
    }

    public BookResponse findById(Long id) {
        return BookMapper.toResponse(getExisting(id));
    }

    public synchronized BookResponse create(BookRequest request) {
        Book book = BookMapper.toModel(request);
        ensureIsbnIsFree(book.isbn(), null);
        return BookMapper.toResponse(save(book));
    }

    public synchronized BookResponse update(Long id, BookRequest request) {
        getExisting(id);
        Book updated = BookMapper.toModel(request).withId(id);
        ensureIsbnIsFree(updated.isbn(), id);
        books.put(id, updated);
        return BookMapper.toResponse(updated);
    }

    public BookResponse updatePrice(Long id, BigDecimal newPrice) {
        Book result = books.computeIfPresent(id, (key, existing) -> new Book(
                existing.id(), existing.title(), existing.isbn(), newPrice, existing.publishedYear()));
        if (result == null) {
            throw new BookNotFoundException(id);
        }
        return BookMapper.toResponse(result);
    }

    public void delete(Long id) {
        if (books.remove(id) == null) {
            throw new BookNotFoundException(id);
        }
    }

    private Book getExisting(Long id) {
        Book book = books.get(id);
        if (book == null) {
            throw new BookNotFoundException(id);
        }
        return book;
    }

    private void ensureIsbnIsFree(String isbn, Long ownId) {
        boolean taken = books.values().stream()
                .anyMatch(b -> b.isbn().equals(isbn) && !b.id().equals(ownId));
        if (taken) {
            throw new DuplicateIsbnException(isbn);
        }
    }

    private Book save(Book book) {
        long id = idSequence.incrementAndGet();
        Book saved = book.withId(id);
        books.put(id, saved);
        return saved;
    }
}
~~~

Notes: lookups now return ^BookResponse^ directly instead of ^Optional^, because "not found" is expressed by an exception. ^create^ and ^update^ are ^synchronized^ so the "check ISBN then insert" sequence is atomic in memory. In Module 3 a **unique database constraint** replaces this, which is the only truly reliable approach across multiple app instances. We also changed DELETE to return 404 for an unknown id; this is a documented design choice (both are acceptable, see 2.1).

### 2.6 The controller gets thinner

~~~java src/main/java/com/example/bookstore/controller/BookController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.dto.PriceUpdateRequest;
import com.example.bookstore.service.BookService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
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
    public List<BookResponse> getBooks(
            @RequestParam(required = false) @Size(min = 2, max = 100) String title,
            @RequestParam(required = false) @DecimalMin("0.00") BigDecimal maxPrice) {
        return bookService.findAll(title, maxPrice);
    }

    @GetMapping("/{id}")
    public BookResponse getBook(@PathVariable @Positive Long id) {
        return bookService.findById(id);
    }

    @PostMapping
    public ResponseEntity<BookResponse> createBook(@Valid @RequestBody BookRequest request) {
        BookResponse created = bookService.create(request);
        URI location = ServletUriComponentsBuilder
                .fromCurrentRequest()
                .path("/{id}")
                .buildAndExpand(created.id())
                .toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{id}")
    public BookResponse updateBook(@PathVariable @Positive Long id,
                                   @Valid @RequestBody BookRequest request) {
        return bookService.update(id, request);
    }

    @PatchMapping("/{id}/price")
    public BookResponse updatePrice(@PathVariable @Positive Long id,
                                    @Valid @RequestBody PriceUpdateRequest request) {
        return bookService.updatePrice(id, request.price());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteBook(@PathVariable @Positive Long id) {
        bookService.delete(id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/paged")
    public List<BookResponse> getBooksPaged(
            @RequestParam(defaultValue = "0") @Min(0) int page,
            @RequestParam(defaultValue = "10") @Min(1) @Max(100) int size) {
        return bookService.findAll(null, null).stream()
                .skip((long) page * size)
                .limit(size)
                .toList();
    }
}
~~~

All the ^.map(ResponseEntity::ok).orElse(notFound())^ noise is gone. The happy path reads naturally; error paths are handled in one place.

### 2.7 Try it

Not found:

~~~text
curl -i http://localhost:8080/api/books/42
~~~

~~~json
HTTP/1.1 404
Content-Type: application/problem+json

{
  "type": "https://api.bookstore.example/problems/book-not-found",
  "title": "Book not found",
  "status": 404,
  "detail": "Book with id 42 does not exist",
  "instance": "/api/books/42",
  "errorCode": "BOOK_NOT_FOUND",
  "timestamp": "2026-11-20T20:41:07.512Z"
}
~~~

Validation failure:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"\",\"isbn\":\"123\",\"price\":-5,\"publishedYear\":2020}"
~~~

~~~json
HTTP/1.1 400
Content-Type: application/problem+json

{
  "type": "https://api.bookstore.example/problems/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "detail": "Request body has 3 invalid field(s)",
  "instance": "/api/books",
  "errorCode": "VALIDATION_FAILED",
  "timestamp": "2026-11-20T20:42:10.004Z",
  "errors": [
    { "field": "title", "message": "title is required", "code": "NotBlank" },
    { "field": "isbn", "message": "isbn must be a valid ISBN-13", "code": "ValidIsbn" },
    { "field": "price", "message": "price must be greater than 0", "code": "DecimalMin" }
  ]
}
~~~

(The order of field errors is not guaranteed.) Duplicate ISBN:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"Clean Code 2\",\"isbn\":\"9780132350884\",\"price\":30,\"publishedYear\":2024}"
~~~

Returns ^409^ with ^"errorCode": "DUPLICATE_ISBN"^. Malformed JSON (^"price":"abc"^) returns 400 with ^MALFORMED_REQUEST^. ^curl -i -X PATCH http://localhost:8080/api/books^ returns 405 as a problem+json from the base class.

To see the catch-all in action, temporarily add this to the controller, call it, then remove it:

~~~java
@GetMapping("/boom")
public String boom() {
    throw new IllegalStateException("database password is hunter2");
}
~~~

The client receives a 500 with only the generic detail and an ^errorId^; the secret message appears only in the server log next to the same errorId. That is exactly the separation you want.

PowerShell, reading a problem response:

~~~powershell
$r = Invoke-WebRequest -Uri http://localhost:8080/api/books/42 -SkipHttpErrorCheck
$r.StatusCode
$r.Headers["Content-Type"]
($r.Content | ConvertFrom-Json).errorCode
~~~

### 2.8 Files in this lesson

| File | Status |
|---|---|
| exception/ErrorCode.java | New |
| exception/BookstoreException.java | New |
| exception/BookNotFoundException.java | New |
| exception/DuplicateIsbnException.java | New |
| exception/GlobalExceptionHandler.java | New |
| service/BookService.java | Changed |
| controller/BookController.java | Changed |
| application.yml | Changed |

---

## 3. Common Pitfalls & Best Practices

- **Leaking stack traces or exception messages.** ^ex.getMessage()^ of an unexpected exception can contain SQL or secrets. Fix: generic detail plus errorId for the client; full details only in logs.
- **Declaring @ExceptionHandler(MethodArgumentNotValidException.class) while extending ResponseEntityExceptionHandler.** Startup fails with an ambiguous handler error. Fix: override ^handleMethodArgumentNotValid^.
- **Throwing HTTP concepts from the service.** ^ResponseStatusException^ in a service couples business logic to the web. Fix: throw domain exceptions; map them in the advice.
- **Clients parsing human messages.** Changing a message text breaks integrations. Fix: expose stable ^errorCode^ values and a ^type^ URI.
- **Logging every 4xx as ERROR with a stack trace.** Floods logs and alerting. Fix: WARN or DEBUG for client errors, ERROR for 5xx.
- **Echoing rejected values in validation errors.** Can reflect sensitive data or enable XSS in naive frontends. Fix: return field, message and code only.
- **Multiple @ControllerAdvice classes without order.** Unpredictable which one wins. Fix: one global advice, or explicit ^@Order^ and ^basePackages^ scoping.
- **Relying on check-then-insert for uniqueness.** Race conditions across threads and instances. Fix: database unique constraint (Module 3) and translate the violation into a 409.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Extend the error model","tasks":["Add an ^InvalidPriceChangeException^ thrown when ^PATCH /api/books/{id}/price^ would increase the price by more than 50 percent. Map it to 422 Unprocessable Entity with error code ^PRICE_CHANGE_TOO_LARGE^.","Override ^handleTypeMismatch^ (or the relevant base method) so ^GET /api/books/abc^ returns your problem format with error code ^VALIDATION_FAILED^ and a clear detail.","Verify with ^curl -i^ that every error response has ^Content-Type: application/problem+json^.","Trigger the catch-all with a temporary endpoint and confirm the errorId in the response matches the one in the log."]},
{"title":"Exercise 2 (Challenge): Production-grade problems","tasks":["Make the ^type^ base URI configurable via a property (use ^@ConfigurationProperties^ or ^@Value(\"§{bookstore.problems.base-uri:https://api.bookstore.example/problems/}\")^) instead of a constant.","Use Spring's ^MessageSource^ so that problem titles can be translated by the ^Accept-Language^ header (add a ^messages_de.properties^).","Read the RFC 9457 text and list what changed compared to RFC 7807, and whether ^type^ should be resolvable documentation.","Write a short markdown page (in the project's docs folder) documenting every errorCode, its status, and when it happens."]},
{"title":"Exercise 3 (Thinking): Error handling strategy","tasks":["Explain the order in which DispatcherServlet consults HandlerExceptionResolvers and what happens if none resolves the exception.","Should DELETE of a non-existent book return 204 or 404? Write arguments for both from an API consumer perspective.","Why must a catch-all handler never return ^ex.getMessage()^? Give two realistic examples of sensitive data in exception messages.","How would you correlate an errorId with all other log lines of the same request? (Preview of MDC in Module 6.)"]}
]
};
