LESSONS['2.2']={
md:String.raw`## 1. Concept & Theory

> **Where the project stands:** after Lesson 2.1 the **bookstore** project has a ^BookController^ with full CRUD on ^/api/books^, backed by an in-memory ^BookService^ (a ^ConcurrentHashMap^). The controller accepts and returns the ^Book^ model directly and accepts **any** input, even a book with no title and a negative price. In this lesson we introduce **DTOs** (^BookRequest^, ^BookResponse^), a **mapper**, and **Bean Validation**. New files: ^dto/BookRequest.java^, ^dto/BookResponse.java^, ^dto/BookMapper.java^, ^dto/PriceUpdateRequest.java^, ^validation/ValidIsbn.java^, ^validation/IsbnValidator.java^ (in package ^com.example.bookstore.dto.validation^). Changed files: ^BookService.java^, ^BookController.java^.

### 1.1 How @RequestBody works

When a method parameter is annotated with ^@RequestBody^, Spring MVC's ^RequestResponseBodyMethodProcessor^ handles it:

1. It reads the ^Content-Type^ header of the request (for example ^application/json^).
2. It iterates over the registered ^HttpMessageConverter^ list and picks the first one that can read that media type into the parameter's Java type. For JSON that is ^MappingJackson2HttpMessageConverter^.
3. Jackson's ^ObjectMapper^ parses the bytes and builds the object. For **records**, Jackson calls the canonical constructor, matching JSON property names to record component names.
4. If the parameter is also annotated with ^@Valid^ (or ^@Validated^), the processor runs **Bean Validation** on the freshly built object. On failure it throws ^MethodArgumentNotValidException^.
5. Only then is your controller method invoked.

What can go wrong before your code runs, and what the client gets by default:

| Problem | Exception | Default status |
|---|---|---|
| Content-Type not supported (e.g. text/plain) | HttpMediaTypeNotSupportedException | 415 |
| Malformed JSON, wrong type ("price":"abc") | HttpMessageNotReadableException | 400 |
| Body missing but required | HttpMessageNotReadableException | 400 |
| Valid JSON but fails constraints | MethodArgumentNotValidException | 400 |

This is very important: **your method is never called with invalid data**. Validation is a gate in front of your code.

Spring Boot's auto-configured ObjectMapper ignores unknown JSON properties by default (^FAIL_ON_UNKNOWN_PROPERTIES^ disabled). So if a client sends ^"color":"red"^, it is silently ignored. That is good for forward compatibility (new client, old server). You can make it strict with ^spring.jackson.deserialization.fail-on-unknown-properties=true^ if your API contract demands it.

### 1.2 Why you should never expose entities directly

In Lesson 2.1 we used the ^Book^ model as both the request and response type. That works, but in production it causes real incidents:

- **Mass assignment / over-posting.** A client sends ^"id": 999^ or later ^"role":"ADMIN"^ on a User entity. If you bind the request straight to the entity, attackers can set fields they should never control. This exact class of bug has caused breaches (GitHub in 2012 had a famous mass-assignment incident in Rails).
- **Leaking internals.** Entities often contain fields that must not leave the server: password hashes, internal flags, audit columns, cost prices.
- **Tight coupling.** Renaming a database column or entity field silently breaks your public API contract and every client.
- **JPA problems (Module 3).** Serializing JPA entities triggers lazy loading outside transactions (^LazyInitializationException^) and infinite recursion with bidirectional relationships (Author to Books to Author...).
- **Different shapes per operation.** Creating needs no id; reading includes id and maybe computed fields; a price update needs only a price.

**Analogy:** your entity is the kitchen's internal recipe card, with supplier costs and notes. The DTO is the menu description for the guest. You would never hand the recipe card to the guest.

A **DTO** (Data Transfer Object) is a simple object whose only job is to carry data across a boundary, here the HTTP boundary.

### 1.3 Records are perfect DTOs

Java records (Java 16+) give us immutable, concise data carriers with ^equals^, ^hashCode^ and ^toString^. Jackson supports them natively. Bean Validation annotations can be placed directly on record components, and they propagate to the constructor parameters, fields and accessors, so Hibernate Validator finds them.

| Type | Purpose | Contains id? | Validation? |
|---|---|---|---|
| BookRequest | Input for POST and PUT | No | Yes |
| BookResponse | Output for every read/write | Yes | No |
| PriceUpdateRequest | Input for PATCH price | No | Yes |
| Book (model) | Internal domain representation | Yes | No (invariants later) |

### 1.4 The mapper approach

Something must convert between DTOs and the model. Options:

- **Hand-written mapper** (a small class with static or instance methods). Explicit, debuggable, zero magic. Ideal for learning and for small to medium projects.
- **MapStruct**: a compile-time code generator. You write an interface, it generates the mapping code. Fast and type-safe; great for large projects with many DTOs.
- **ModelMapper / reflection-based mappers**: convenient but slow and error-prone (silent wrong mappings). Avoid in new code.

We will write a tiny hand-written mapper. Where should mapping happen: controller or service? Both are seen in practice. We map **in the service layer boundary**: the controller deals only with DTOs, the service accepts a ^BookRequest^ and returns a ^BookResponse^. That keeps the model completely internal, which matters in Module 3 when the model becomes a JPA entity and we want transactions to cover the mapping.

### 1.5 Bean Validation (jakarta.validation)

**Jakarta Bean Validation** is a specification (^jakarta.validation.*^). **Hibernate Validator** is the reference implementation, brought in by ^spring-boot-starter-validation^. Spring Boot auto-configures a ^LocalValidatorFactoryBean^ that MVC uses.

Most useful built-in constraints:

| Annotation | Meaning | Null allowed? |
|---|---|---|
| @NotNull | must not be null | No |
| @NotEmpty | not null and length/size > 0 | No |
| @NotBlank | not null and at least one non-whitespace char (Strings only) | No |
| @Size(min, max) | length of String or size of collection | Yes |
| @Min / @Max | numeric bounds (integers) | Yes |
| @DecimalMin / @DecimalMax | numeric bounds as String, good for BigDecimal | Yes |
| @Positive / @PositiveOrZero | greater than zero / greater or equal zero | Yes |
| @Digits(integer, fraction) | max digits before/after decimal point | Yes |
| @Pattern(regexp) | String matches regex | Yes |
| @Email | well-formed email | Yes |
| @Past / @Future / @PastOrPresent | temporal constraints | Yes |

**Key insight:** almost all constraints treat ^null^ as **valid**. ^@Size(max = 200)^ on a null String passes. That is by design so constraints compose: combine ^@NotNull^ (or ^@NotBlank^) with the others when the value is mandatory.

### 1.6 @Valid vs @Validated

| | @Valid | @Validated |
|---|---|---|
| Package | jakarta.validation | org.springframework.validation.annotation |
| Standard | Jakarta spec | Spring-specific |
| Cascades into nested objects | Yes (put it on the field) | No |
| Supports validation groups | No | Yes |
| On a class (bean) | No effect | Enables method validation (AOP proxy, older approach) |

On a ^@RequestBody^ parameter both trigger validation; use ^@Valid^ unless you need groups. Put ^@Valid^ on nested DTO fields (e.g. ^@Valid AddressRequest address^, or ^List of @Valid ItemRequest^) to cascade validation into them.

### 1.7 Validating path and query parameters

Since **Spring Framework 6.1** (Boot 3.2+), Spring MVC has **built-in method validation**. If you put constraint annotations directly on controller method parameters, like ^@PathVariable @Positive Long id^ or ^@RequestParam @Max(100) int size^, Spring validates them automatically, **no class-level @Validated needed**. A violation raises ^HandlerMethodValidationException^, which maps to **400**.

Older tutorials tell you to put ^@Validated^ on the controller class. That still works (it uses an AOP proxy and throws ^ConstraintViolationException^, which by default becomes a **500**, a classic gotcha), but with Boot 3.4 the built-in mechanism is the modern, recommended approach. Do **not** combine both on the same controller, or you get double validation and confusing exception types.

### 1.8 Custom constraints

When built-ins are not enough, you write your own constraint: an annotation plus a ^ConstraintValidator^. Example: a real **ISBN-13 checksum** check. A regex can verify "13 digits", but only code can verify the check digit. Hibernate Validator actually ships ^@ISBN^ (^org.hibernate.validator.constraints.ISBN^), but writing our own teaches the mechanism you will need for business rules like "valid SKU", "allowed currency" or "end date after start date".

How it works under the hood: at validation time, Hibernate Validator sees an annotation that is meta-annotated with ^@Constraint(validatedBy = ...)^, instantiates the validator (through Spring, so you can even inject beans into it), calls ^initialize^ once with the annotation, then ^isValid^ for each value.

### 1.9 Validation groups (briefly)

Groups let the same DTO be validated differently depending on context, e.g. "on create the ISBN is required, on update it is optional". You define marker interfaces (^OnCreate^, ^OnUpdate^), assign constraints to groups with ^groups = OnCreate.class^, and trigger with ^@Validated(OnCreate.class)^. They work, but in practice they make DTOs hard to read. **Most teams prefer separate DTOs per operation** (as we do with ^PriceUpdateRequest^). Use groups sparingly.

### 1.10 What is MethodArgumentNotValidException?

It is the exception Spring MVC throws when a ^@Valid @RequestBody^ (or ^@ModelAttribute^) fails validation. It extends ^BindException^ and carries a ^BindingResult^ containing every ^FieldError^ (field name, rejected value, message, error code like ^NotBlank^) and ^ObjectError^ (class-level errors). Spring Boot's default handling returns a 400. Out of the box, the response body is generic. In Lesson 2.3 we catch it in a global handler and return a clean list of field errors in a ProblemDetail.

---

## 2. Code Walkthrough

### 2.1 The DTOs

~~~java src/main/java/com/example/bookstore/dto/BookRequest.java
package com.example.bookstore.dto;

import com.example.bookstore.dto.validation.ValidIsbn;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

public record BookRequest(

        @NotBlank(message = "title is required")
        @Size(max = 200, message = "title must be at most 200 characters")
        String title,

        @NotBlank(message = "isbn is required")
        @ValidIsbn
        String isbn,

        @NotNull(message = "price is required")
        @DecimalMin(value = "0.00", inclusive = false, message = "price must be greater than 0")
        @DecimalMax(value = "10000.00", message = "price must be at most 10000")
        @Digits(integer = 5, fraction = 2, message = "price must have at most 2 decimal places")
        BigDecimal price,

        @Min(value = 1450, message = "publishedYear must be 1450 or later")
        @Max(value = 2100, message = "publishedYear must be 2100 or earlier")
        int publishedYear
) {
}
~~~

Note on ^int publishedYear^: a primitive can never be null; if the client omits it, Jackson sets 0, and ^@Min(1450)^ catches it. If you want a clearer "is required" message, use ^Integer^ with ^@NotNull^. Both are valid designs.

~~~java src/main/java/com/example/bookstore/dto/BookResponse.java
package com.example.bookstore.dto;

import java.math.BigDecimal;

public record BookResponse(
        Long id,
        String title,
        String isbn,
        BigDecimal price,
        int publishedYear
) {
}
~~~

Right now ^BookResponse^ looks identical to ^Book^. That is normal at the start. They will diverge quickly: in Module 3 the entity gains relationships and audit fields, and the response may gain an ^authorName^ instead of a full Author object.

~~~java src/main/java/com/example/bookstore/dto/PriceUpdateRequest.java
package com.example.bookstore.dto;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.NotNull;

import java.math.BigDecimal;

public record PriceUpdateRequest(
        @NotNull(message = "price is required")
        @DecimalMin(value = "0.00", inclusive = false, message = "price must be greater than 0")
        @Digits(integer = 5, fraction = 2)
        BigDecimal price
) {
}
~~~

### 2.2 The mapper

~~~java src/main/java/com/example/bookstore/dto/BookMapper.java
package com.example.bookstore.dto;

import com.example.bookstore.model.Book;

public final class BookMapper {

    private BookMapper() {
    }

    public static Book toModel(BookRequest request) {
        return new Book(
                null,
                request.title().trim(),
                normalizeIsbn(request.isbn()),
                request.price(),
                request.publishedYear());
    }

    public static BookResponse toResponse(Book book) {
        return new BookResponse(
                book.id(),
                book.title(),
                book.isbn(),
                book.price(),
                book.publishedYear());
    }

    private static String normalizeIsbn(String isbn) {
        return isbn.replace("-", "").replace(" ", "");
    }
}
~~~

A static utility mapper is simple and has no state. If you later need injected collaborators (e.g. to look up an Author), turn it into a ^@Component^ and inject it.

### 2.3 The custom ISBN constraint

~~~java src/main/java/com/example/bookstore/dto/validation/ValidIsbn.java
package com.example.bookstore.dto.validation;

import jakarta.validation.Constraint;
import jakarta.validation.Payload;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Documented
@Constraint(validatedBy = IsbnValidator.class)
@Target({ElementType.FIELD, ElementType.PARAMETER, ElementType.RECORD_COMPONENT, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface ValidIsbn {

    String message() default "isbn must be a valid ISBN-13";

    Class<?>[] groups() default {};

    Class<? extends Payload>[] payload() default {};
}
~~~

The three attributes ^message^, ^groups^ and ^payload^ are **mandatory** by the spec; Hibernate Validator refuses to start validation for a constraint without them.

~~~java src/main/java/com/example/bookstore/dto/validation/IsbnValidator.java
package com.example.bookstore.dto.validation;

import jakarta.validation.ConstraintValidator;
import jakarta.validation.ConstraintValidatorContext;

public class IsbnValidator implements ConstraintValidator<ValidIsbn, String> {

    @Override
    public boolean isValid(String value, ConstraintValidatorContext context) {
        if (value == null) {
            return true; // let @NotBlank handle null, so constraints compose
        }
        String digits = value.replace("-", "").replace(" ", "");
        if (digits.length() != 13 || !digits.chars().allMatch(Character::isDigit)) {
            return false;
        }
        int sum = 0;
        for (int i = 0; i < 12; i++) {
            int d = digits.charAt(i) - '0';
            sum += (i % 2 == 0) ? d : d * 3;
        }
        int check = (10 - (sum % 10)) % 10;
        return check == digits.charAt(12) - '0';
    }
}
~~~

The ISBN-13 algorithm: weight the first 12 digits alternately by 1 and 3, sum them, and the check digit is what brings the total to a multiple of 10. "9780132350884" passes; change the last digit and it fails.

### 2.4 The service, now speaking DTOs

~~~java src/main/java/com/example/bookstore/service/BookService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.BookMapper;
import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
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

    public Optional<BookResponse> findById(Long id) {
        return Optional.ofNullable(books.get(id)).map(BookMapper::toResponse);
    }

    public BookResponse create(BookRequest request) {
        Book saved = save(BookMapper.toModel(request));
        return BookMapper.toResponse(saved);
    }

    public Optional<BookResponse> update(Long id, BookRequest request) {
        if (!books.containsKey(id)) {
            return Optional.empty();
        }
        Book updated = BookMapper.toModel(request).withId(id);
        books.put(id, updated);
        return Optional.of(BookMapper.toResponse(updated));
    }

    public Optional<BookResponse> updatePrice(Long id, BigDecimal newPrice) {
        Book result = books.computeIfPresent(id, (key, existing) -> new Book(
                existing.id(), existing.title(), existing.isbn(), newPrice, existing.publishedYear()));
        return Optional.ofNullable(result).map(BookMapper::toResponse);
    }

    public boolean delete(Long id) {
        return books.remove(id) != null;
    }

    private Book save(Book book) {
        long id = idSequence.incrementAndGet();
        Book saved = book.withId(id);
        books.put(id, saved);
        return saved;
    }
}
~~~

Note ^computeIfPresent^ for the price update: it is atomic on a ^ConcurrentHashMap^, so two concurrent price updates cannot interleave badly. The model ^Book^ never leaves the service.

### 2.5 The controller

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
    public ResponseEntity<BookResponse> getBook(@PathVariable @Positive Long id) {
        return bookService.findById(id)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
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
    public ResponseEntity<BookResponse> updateBook(
            @PathVariable @Positive Long id,
            @Valid @RequestBody BookRequest request) {
        return bookService.update(id, request)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @PatchMapping("/{id}/price")
    public ResponseEntity<BookResponse> updatePrice(
            @PathVariable @Positive Long id,
            @Valid @RequestBody PriceUpdateRequest request) {
        return bookService.updatePrice(id, request.price())
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
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

What changed:

1. Every endpoint speaks DTOs only. The ^Book^ model is no longer imported here.
2. ^@Valid @RequestBody BookRequest^ triggers validation before the method runs.
3. Constraints on ^@PathVariable^ and ^@RequestParam^ (like ^@Positive^, ^@Max(100)^) are enforced by Spring 6.1+ built-in method validation. No ^@Validated^ on the class.
4. The page size is capped at 100. In production, an uncapped ^size^ parameter is a denial-of-service vector: one request with ^size=10000000^ can exhaust memory.

### 2.6 Try it

Valid creation, with a correct ISBN-13:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"Refactoring\",\"isbn\":\"978-0134757599\",\"price\":47.99,\"publishedYear\":2018}"
~~~

Expected: ^201^ with ^Location: http://localhost:8080/api/books/4^ and the normalized ISBN ^9780134757599^ in the body.

Invalid creation:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\":\"\",\"isbn\":\"9780134757590\",\"price\":-5,\"publishedYear\":1200}"
~~~

Expected: ^HTTP/1.1 400^. With Boot defaults, the body is the generic error JSON:

~~~json
{
  "timestamp": "2026-11-20T20:15:03.123+00:00",
  "status": 400,
  "error": "Bad Request",
  "path": "/api/books"
}
~~~

The console log shows a WARN line like:

~~~text
Resolved [org.springframework.web.bind.MethodArgumentNotValidException: Validation failed for argument [0] ... with 4 errors: [Field error in object 'bookRequest' on field 'title': rejected value []; ... default message [title is required]] ...
~~~

All four violations are collected (validation does not stop at the first error). The client cannot see them yet: Boot hides details by default (^server.error.include-binding-errors=never^) to avoid leaking information. In Lesson 2.3 we design a proper error response that exposes exactly the field errors and nothing else.

Validation of path and query params:

~~~text
curl -i http://localhost:8080/api/books/-1
curl -i "http://localhost:8080/api/books/paged?size=5000"
~~~

Both return ^400^ (from ^HandlerMethodValidationException^).

Malformed JSON:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d "{\"title\": \"Oops\", \"price\": \"abc\"}"
~~~

Returns ^400^ via ^HttpMessageNotReadableException^, because Jackson cannot turn "abc" into a BigDecimal. Wrong content type:

~~~text
curl -i -X POST http://localhost:8080/api/books -H "Content-Type: text/plain" -d "hello"
~~~

Returns ^415 Unsupported Media Type^.

PowerShell equivalent of the invalid request, showing the status code:

~~~powershell
$body = @{ title = ""; isbn = "123"; price = -5; publishedYear = 1200 } | ConvertTo-Json
$r = Invoke-WebRequest -Method Post -Uri http://localhost:8080/api/books -ContentType "application/json" -Body $body -SkipHttpErrorCheck
$r.StatusCode
$r.Content
~~~

### 2.7 Validation groups in a nutshell (reference only)

We do not use groups in the bookstore, but this is what they look like:

~~~java src/main/java/com/example/bookstore/dto/validation/ValidationGroups.java
package com.example.bookstore.dto.validation;

public final class ValidationGroups {
    private ValidationGroups() {
    }

    public interface OnCreate {
    }

    public interface OnUpdate {
    }
}
~~~

You would then write ^@NotBlank(groups = ValidationGroups.OnCreate.class) String isbn^ and a controller parameter ^@Validated(ValidationGroups.OnCreate.class) @RequestBody BookRequest request^. Constraints without a group belong to the ^Default^ group, which is **not** validated when you specify another group unless your group interface extends ^jakarta.validation.groups.Default^. That subtlety bites many teams, which is another reason to prefer separate DTOs.

### 2.8 Files in this lesson

| File | Status |
|---|---|
| dto/BookRequest.java | New |
| dto/BookResponse.java | New |
| dto/PriceUpdateRequest.java | New |
| dto/BookMapper.java | New |
| dto/validation/ValidIsbn.java | New |
| dto/validation/IsbnValidator.java | New |
| dto/validation/ValidationGroups.java | New (reference, optional) |
| service/BookService.java | Changed |
| controller/BookController.java | Changed |
| model/Book.java | Unchanged |

---

## 3. Common Pitfalls & Best Practices

- **Forgetting @Valid.** Annotations on the DTO do nothing unless validation is triggered. Fix: always write ^@Valid @RequestBody^; write a test that sends invalid data and expects 400.
- **Forgetting the validation starter.** Without ^spring-boot-starter-validation^ there is no validator, constraints are silently ignored. Fix: add the starter (we did in 2.1).
- **Using @NotNull on Strings when you mean @NotBlank.** ^""^ and ^"   "^ pass ^@NotNull^. Fix: ^@NotBlank^ for required text.
- **Expecting @Size or @Pattern to reject null.** They accept null. Fix: combine with ^@NotNull^ or ^@NotBlank^.
- **Binding requests directly to entities.** Opens mass-assignment holes and couples API to persistence. Fix: dedicated request and response records plus a mapper.
- **Adding @Validated on the controller class in Boot 3.2+.** Causes double validation and ^ConstraintViolationException^ (500 by default). Fix: rely on built-in method validation; put constraints directly on parameters.
- **Uncapped page sizes and string lengths.** A huge ^size^ or a 50 MB title is a DoS risk. Fix: ^@Max^ on sizes, ^@Size(max)^ on strings, and server limits like ^server.tomcat.max-swallow-size^.
- **Custom validators that reject null.** They break composition and produce duplicate messages. Fix: return ^true^ for null and let ^@NotNull^ decide.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Strengthen the DTOs","tasks":["Change ^publishedYear^ in ^BookRequest^ to ^Integer^ with ^@NotNull^ and verify the difference when the field is omitted.","Add a ^@PastOrPresent^-style rule so that ^publishedYear^ cannot be in the future (hint: ^@Max^ cannot use the current year dynamically, so think about a custom constraint).","Add an optional ^description^ field to both DTOs, max 2000 characters, and map it through ^Book^.","Send at least five different invalid requests with curl and note in the console which exception and how many field errors each produces."]},
{"title":"Exercise 2 (Challenge): Custom constraint and nested validation","tasks":["Create a class-level constraint ^@ValidBookPricing^ that rejects books published before 1900 with a price above 5000 (a toy business rule). Target ^ElementType.TYPE^ and attach the error to the ^price^ field using ^ConstraintValidatorContext.buildConstraintViolationWithTemplate^.","Add a nested record ^AuthorRequest(String name)^ and a field ^List of AuthorRequest^ named ^authors^ to ^BookRequest^ with ^@NotEmpty^ and cascading validation. Prove that an author with a blank name is rejected.","Enable ^spring.jackson.deserialization.fail-on-unknown-properties=true^, send an unknown field, and document the resulting status and exception.","Read the Hibernate Validator reference guide chapter on creating custom constraints and list two features we did not use."]},
{"title":"Exercise 3 (Thinking): Design decisions","tasks":["Explain in your own words three concrete production risks of returning JPA entities directly from controllers.","Compare hand-written mappers and MapStruct: when would you switch, and what does MapStruct generate at compile time?","Where should ISBN uniqueness be checked: in a constraint validator, in the service, or in the database? Justify your answer considering concurrency.","Why does Spring Boot hide binding errors in the default error response? What could an attacker learn from overly detailed errors?"]}
]
};
