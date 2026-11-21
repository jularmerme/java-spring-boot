LESSONS['7.2']={
md:String.raw`# Lesson 7.2 - Capstone Part 2: Services, REST API, Validation, Errors & Security

> **Where we stand:** TaskFlow boots against PostgreSQL, Flyway has applied V1, and we have entities (^User^, ^Project^, ^Task^), enums and repositories including ^TaskSpecifications^. Nothing is exposed over HTTP yet and Spring Security's default login is blocking everything. In this lesson we build the whole application layer: DTOs, mappers, services, controllers, error handling, JWT security with ownership rules, OpenAPI docs, optimistic locking and a request-id filter.

**New files:** everything under ^common/^ and ^security/^, plus DTOs, mappers, services and controllers in ^user/^, ^project/^ and ^task/^. **Changed:** none of the Lesson 7.1 files.

---

## 1. Concept & Theory

### 1.1 The responsibilities of each layer

| Layer | Owns | Must never |
|---|---|---|
| Filter chain | request id, authentication, CORS | contain business rules |
| Controller | HTTP: paths, status codes, headers, binding, ^@Valid^ | open transactions, call repositories, return entities |
| Mapper | entity to DTO and back | call the DB (data must already be fetched) |
| Service | use cases, transactions, authorization of ownership, invariants | know about HTTP (no ^ResponseEntity^) |
| Repository | queries | contain business logic |
| Exception handler | turning exceptions into ProblemDetail | swallow unexpected errors silently |

**Analogy:** a restaurant. The waiter (controller) takes orders in the customer's language and serves plates. The kitchen (service) decides how dishes are made and refuses to serve a dish to someone who did not order it. The pantry (repository) only stores and fetches ingredients. The manager (exception handler) apologises in a standard format when something goes wrong.

### 1.2 How @Transactional really works

When Spring sees ^@Transactional^ on a bean, it wraps the bean in a **proxy** (CGLIB subclass). A call from the controller goes to the proxy, which asks the ^PlatformTransactionManager^ (here ^JpaTransactionManager^) to begin a transaction, binds an ^EntityManager^ to the current thread, invokes your real method, then commits (flushing dirty entities) or rolls back on a ^RuntimeException^.

Consequences you must know:

- **Self-invocation bypasses the proxy.** ^this.otherMethod()^ inside the same class does not start a new transaction.
- **Dirty checking:** inside a transaction you do not call ^save()^ after modifying a managed entity. At flush Hibernate compares the entity with its snapshot and issues the UPDATE, including ^version = version + 1^.
- **^readOnly = true^** sets Hibernate's flush mode to manual and lets the driver/pool route to replicas; use it for every query method.
- With ^open-in-view: false^, lazy associations can only be touched **inside** the service. So we map to DTOs in the service and return DTOs.

### 1.3 Stateless JWT authentication in one picture

~~~text
POST /api/auth/login {email,password}
   --> AuthenticationManager --> DaoAuthenticationProvider --> UserDetailsService (load by email)
                                                         --> PasswordEncoder.matches (BCrypt)
   <-- 200 {accessToken, expiresIn}

GET /api/projects   Authorization: Bearer eyJ...
   --> JwtAuthFilter: parse + verify HMAC signature + expiry
       --> build AuthUser(id, email, role) principal, put in SecurityContextHolder
   --> AuthorizationFilter: checks requestMatchers rules (authenticated? hasRole ADMIN?)
   --> Controller --> @PreAuthorize("@projectSecurity.canAccess(#id)") evaluated by method-security proxy
~~~

The JWT carries the user id as subject plus email and role as claims, signed with an HMAC-SHA256 secret. The server keeps no session: any instance can validate any token, which is why it scales horizontally. The price: you cannot easily revoke a token before expiry, so keep access tokens short (1 hour here) and add refresh tokens later.

### 1.4 RBAC plus ownership: two different questions

**Role-based access control** answers "what kind of user are you?" (USER or ADMIN). **Ownership** answers "is this particular row yours?". Roles fit in URL rules; ownership needs data. TaskFlow's rules:

| Action | USER | ADMIN |
|---|---|---|
| List projects | only own | all |
| Read/update/delete a project | if owner | always |
| Create/update/delete task | if owner of the task's project | always |
| Change task status | project owner or assignee | always |
| Read a task | project owner or assignee | always |
| /api/admin/** | denied | allowed |

We show **both** standard techniques:

- **Bean expression in ^@PreAuthorize^:** ^@PreAuthorize("@projectSecurity.isOwnerOrAdmin(#projectId)")^. Spring's method-security interceptor evaluates the SpEL expression before the method runs; ^@projectSecurity^ resolves a bean by name, ^#projectId^ binds the method parameter (works because Boot compiles with ^-parameters^). Clean and declarative, great for "can access this project".
- **Service-level checks:** for tasks we already load the task with its project in the service, so we check there and throw ^AccessDeniedException^. No extra query, and the rule is unit-testable without Spring.

Rule of thumb: URL rules for roles, method or service checks for ownership. **Never** trust the client to send "ownerId".

### 1.5 Optimistic locking end-to-end

Two people open task 42 at version 3. Alice saves first: version becomes 4. Bob saves with version 3. We want Bob to get **409 Conflict** with a clear message instead of silently erasing Alice's change (the "lost update" problem).

Two layers of defence:

1. **Explicit check in the service:** the request carries ^version^; if it differs from the loaded entity's version we throw ^ObjectOptimisticLockingFailureException^ immediately.
2. **Hibernate's ^@Version^:** if two requests pass the check at the same instant, the second UPDATE ^... WHERE id=42 AND version=3^ affects 0 rows and Hibernate throws; Spring translates it into ^ObjectOptimisticLockingFailureException^.

Both end in the same handler method returning 409. Optimistic locking costs nothing when there is no conflict, unlike pessimistic ^SELECT ... FOR UPDATE^, which is why it is the default choice for web apps.

### 1.6 Errors as ProblemDetail (RFC 9457)

| Exception | Status | type suffix |
|---|---|---|
| ^MethodArgumentNotValidException^ | 400 | validation-error (with field errors) |
| ^ResourceNotFoundException^ | 404 | not-found |
| ^AccessDeniedException^ | 403 | forbidden |
| ^BadCredentialsException^ | 401 | invalid-credentials |
| ^DuplicateResourceException^ | 409 | duplicate |
| ^ObjectOptimisticLockingFailureException^ | 409 | conflict |
| ^IllegalStateException^ (business rule) | 422 | business-rule |
| anything else | 500 | internal (no details leaked) |

Every response also includes the ^requestId^ so a user's bug report can be matched to server logs in seconds.

### 1.7 The request-id filter and MDC

**MDC** (Mapped Diagnostic Context) is a thread-local map in SLF4J/Logback. Put ^requestId^ in it at the start of a request and every log line on that thread can print it via the pattern ^%X{requestId}^. The filter reuses an incoming ^X-Request-Id^ header (from a gateway or load balancer) or generates a UUID, echoes it in the response, and **always** clears MDC in ^finally^, because Tomcat reuses threads: a leaked value would tag the next user's logs.

---

## 2. Code Walkthrough

### Step 1 - Common: exceptions

~~~java src/main/java/com/example/taskflow/common/ResourceNotFoundException.java
package com.example.taskflow.common;

public class ResourceNotFoundException extends RuntimeException {

    public ResourceNotFoundException(String resource, Object id) {
        super(resource + " with id " + id + " not found");
    }
}
~~~

~~~java src/main/java/com/example/taskflow/common/DuplicateResourceException.java
package com.example.taskflow.common;

public class DuplicateResourceException extends RuntimeException {

    public DuplicateResourceException(String message) {
        super(message);
    }
}
~~~

~~~java src/main/java/com/example/taskflow/common/PageResponse.java
package com.example.taskflow.common;

import org.springframework.data.domain.Page;

import java.util.List;

/** Stable JSON shape for paged results, independent of Spring's PageImpl serialization. */
public record PageResponse<T>(List<T> content, int page, int size, long totalElements, int totalPages) {

    public static <T> PageResponse<T> from(Page<T> page) {
        return new PageResponse<>(page.getContent(), page.getNumber(), page.getSize(),
                page.getTotalElements(), page.getTotalPages());
    }
}
~~~

Why a custom ^PageResponse^? Serializing ^PageImpl^ directly exposes internal fields and Spring Data 3.3+ logs a warning about its unstable JSON. Your API contract should not change because a library changed.

### Step 2 - Common: request-id filter

~~~java src/main/java/com/example/taskflow/common/RequestIdFilter.java
package com.example.taskflow.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Request-Id";
    public static final String MDC_KEY = "requestId";
    private static final Pattern SAFE = Pattern.compile("[A-Za-z0-9-]{1,64}");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String requestId = (incoming != null && SAFE.matcher(incoming).matches())
                ? incoming
                : UUID.randomUUID().toString();
        MDC.put(MDC_KEY, requestId);
        response.setHeader(HEADER, requestId);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
~~~

The ^SAFE^ pattern stops log injection: an attacker could otherwise send a header containing newlines to forge log lines. ^HIGHEST_PRECEDENCE^ puts it before Spring Security's filter chain, so even 401s carry a request id.

Add the id to every log line:

~~~properties src/main/resources/application.properties
# Only the logging pattern lives here; everything else is in application.yml
logging.pattern.level=%5p [%X{requestId}]
~~~

Spring Boot merges ^.properties^ and ^.yml^; if you prefer, put ^logging.pattern.level^ in the yml instead and skip this file.

### Step 3 - Common: global exception handler

~~~java src/main/java/com/example/taskflow/common/GlobalExceptionHandler.java
package com.example.taskflow.common;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.lang.Nullable;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private static final String TYPE_BASE = "https://taskflow.example.com/problems/";

    @ExceptionHandler(ResourceNotFoundException.class)
    ProblemDetail handleNotFound(ResourceNotFoundException ex) {
        return problem(HttpStatus.NOT_FOUND, "not-found", "Resource not found", ex.getMessage());
    }

    @ExceptionHandler(DuplicateResourceException.class)
    ProblemDetail handleDuplicate(DuplicateResourceException ex) {
        return problem(HttpStatus.CONFLICT, "duplicate", "Duplicate resource", ex.getMessage());
    }

    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    ProblemDetail handleOptimisticLock(ObjectOptimisticLockingFailureException ex) {
        log.info("Optimistic lock conflict: {}", ex.getMessage());
        return problem(HttpStatus.CONFLICT, "conflict", "Concurrent modification",
                "The resource was modified by someone else. Reload it and apply your change again.");
    }

    @ExceptionHandler(AccessDeniedException.class)
    ProblemDetail handleAccessDenied(AccessDeniedException ex) {
        return problem(HttpStatus.FORBIDDEN, "forbidden", "Forbidden",
                "You do not have permission to perform this action");
    }

    @ExceptionHandler(BadCredentialsException.class)
    ProblemDetail handleBadCredentials(BadCredentialsException ex) {
        return problem(HttpStatus.UNAUTHORIZED, "invalid-credentials", "Invalid credentials",
                "Email or password is incorrect");
    }

    @ExceptionHandler(IllegalStateException.class)
    ProblemDetail handleBusinessRule(IllegalStateException ex) {
        return problem(HttpStatus.UNPROCESSABLE_ENTITY, "business-rule", "Business rule violated", ex.getMessage());
    }

    @ExceptionHandler(Exception.class)
    ProblemDetail handleUnexpected(Exception ex) {
        log.error("Unexpected error", ex);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal", "Internal error",
                "An unexpected error occurred. Quote the requestId when contacting support.");
    }

    @Override
    protected ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex,
                                                                  HttpHeaders headers,
                                                                  HttpStatusCode status,
                                                                  WebRequest request) {
        Map<String, String> errors = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors()
                .forEach(fe -> errors.putIfAbsent(fe.getField(), fe.getDefaultMessage()));
        ProblemDetail pd = problem(HttpStatus.BAD_REQUEST, "validation-error", "Validation failed",
                "One or more fields are invalid");
        pd.setProperty("errors", errors);
        return ResponseEntity.badRequest().body(pd);
    }

    @Override
    protected ResponseEntity<Object> createResponseEntity(@Nullable Object body, HttpHeaders headers,
                                                          HttpStatusCode statusCode, WebRequest request) {
        if (body instanceof ProblemDetail pd) {
            pd.setProperty("requestId", MDC.get(RequestIdFilter.MDC_KEY));
        }
        return super.createResponseEntity(body, headers, statusCode, request);
    }

    private ProblemDetail problem(HttpStatus status, String type, String title, String detail) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setType(URI.create(TYPE_BASE + type));
        pd.setTitle(title);
        pd.setProperty("requestId", MDC.get(RequestIdFilter.MDC_KEY));
        return pd;
    }
}
~~~

**Under the hood:** extending ^ResponseEntityExceptionHandler^ gives you ProblemDetail responses for all of Spring MVC's own exceptions (malformed JSON, wrong HTTP method, missing parameter, type mismatch on ^?status=FOO^) for free; we only override validation to add field errors. ^AccessDeniedException^ thrown by ^@PreAuthorize^ happens **inside** the DispatcherServlet (method security runs on the controller proxy), so our advice catches it. Access denials from URL rules happen in the filter chain, before MVC, so they are handled by the security config's entry point and access-denied handler instead (Step 6).

### Step 4 - User feature: DTOs and AuthService

~~~java src/main/java/com/example/taskflow/user/dto/RegisterRequest.java
package com.example.taskflow.user.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RegisterRequest(
        @NotBlank @Email @Size(max = 255) String email,
        @NotBlank @Size(min = 8, max = 72, message = "password must be 8-72 characters") String password) {
}
~~~

~~~java src/main/java/com/example/taskflow/user/dto/LoginRequest.java
package com.example.taskflow.user.dto;

import jakarta.validation.constraints.NotBlank;

public record LoginRequest(@NotBlank String email, @NotBlank String password) {
}
~~~

~~~java src/main/java/com/example/taskflow/user/dto/TokenResponse.java
package com.example.taskflow.user.dto;

public record TokenResponse(String accessToken, String tokenType, long expiresIn) {
}
~~~

~~~java src/main/java/com/example/taskflow/user/dto/UserResponse.java
package com.example.taskflow.user.dto;

import com.example.taskflow.user.Role;
import com.example.taskflow.user.User;

import java.time.Instant;

public record UserResponse(Long id, String email, Role role, Instant createdAt) {

    public static UserResponse from(User user) {
        return new UserResponse(user.getId(), user.getEmail(), user.getRole(), user.getCreatedAt());
    }
}
~~~

Max 72 for the password is not random: BCrypt ignores bytes after 72, so longer "passwords" give a false sense of security.

~~~java src/main/java/com/example/taskflow/user/AuthService.java
package com.example.taskflow.user;

import com.example.taskflow.common.DuplicateResourceException;
import com.example.taskflow.security.AuthUser;
import com.example.taskflow.security.JwtService;
import com.example.taskflow.user.dto.LoginRequest;
import com.example.taskflow.user.dto.RegisterRequest;
import com.example.taskflow.user.dto.TokenResponse;
import com.example.taskflow.user.dto.UserResponse;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final AuthenticationManager authenticationManager;
    private final JwtService jwtService;

    public AuthService(UserRepository userRepository, PasswordEncoder passwordEncoder,
                       AuthenticationManager authenticationManager, JwtService jwtService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.authenticationManager = authenticationManager;
        this.jwtService = jwtService;
    }

    @Transactional
    public UserResponse register(RegisterRequest request) {
        if (userRepository.existsByEmailIgnoreCase(request.email())) {
            throw new DuplicateResourceException("Email already registered");
        }
        User user = new User(request.email(), passwordEncoder.encode(request.password()), Role.USER);
        return UserResponse.from(userRepository.save(user));
    }

    public TokenResponse login(LoginRequest request) {
        Authentication auth = authenticationManager.authenticate(
                new UsernamePasswordAuthenticationToken(request.email().toLowerCase(), request.password()));
        AuthUser principal = (AuthUser) auth.getPrincipal();
        String token = jwtService.generateToken(principal);
        return new TokenResponse(token, "Bearer", jwtService.getExpiration().toSeconds());
    }
}
~~~

Registration always creates ^Role.USER^; a client can never ask to be admin. The ^existsBy^ check gives a nice message, but under a race two requests can both pass it; the ^uk_users_email^ unique constraint is the real guarantee (Exercise 2 asks you to map that ^DataIntegrityViolationException^ to 409 too).

~~~java src/main/java/com/example/taskflow/user/AuthController.java
package com.example.taskflow.user;

import com.example.taskflow.user.dto.LoginRequest;
import com.example.taskflow.user.dto.RegisterRequest;
import com.example.taskflow.user.dto.TokenResponse;
import com.example.taskflow.user.dto.UserResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
@Tag(name = "Authentication")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Register a new user account")
    public UserResponse register(@Valid @RequestBody RegisterRequest request) {
        return authService.register(request);
    }

    @PostMapping("/login")
    @Operation(summary = "Exchange credentials for a JWT access token")
    public TokenResponse login(@Valid @RequestBody LoginRequest request) {
        return authService.login(request);
    }
}
~~~

~~~java src/main/java/com/example/taskflow/user/AdminUserController.java
package com.example.taskflow.user;

import com.example.taskflow.common.PageResponse;
import com.example.taskflow.user.dto.UserResponse;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.data.domain.Pageable;
import org.springframework.data.web.PageableDefault;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/admin/users")
@PreAuthorize("hasRole('ADMIN')")
@Tag(name = "Admin")
@SecurityRequirement(name = "bearerAuth")
public class AdminUserController {

    private final UserRepository userRepository;

    public AdminUserController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @GetMapping
    @Transactional(readOnly = true)
    public PageResponse<UserResponse> list(@PageableDefault(size = 20, sort = "id") Pageable pageable) {
        return PageResponse.from(userRepository.findAll(pageable).map(UserResponse::from));
    }
}
~~~

> This controller uses the repository directly, which breaks our own rule. It is a deliberate shortcut for a trivial read-only admin endpoint, and Exercise 1 asks you to move it into a ^UserService^. Recognising when you cut a corner is a senior skill.

### Step 5 - Security: JWT service, principal, filter

~~~java src/main/java/com/example/taskflow/security/AuthUser.java
package com.example.taskflow.security;

import com.example.taskflow.user.Role;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;

import java.util.Collection;
import java.util.List;

/** Our principal: what we know about the caller during a request. */
public record AuthUser(Long id, String email, String passwordHash, Role role) implements UserDetails {

    public boolean isAdmin() {
        return role == Role.ADMIN;
    }

    @Override
    public Collection<? extends GrantedAuthority> getAuthorities() {
        return List.of(new SimpleGrantedAuthority("ROLE_" + role.name()));
    }

    @Override
    public String getPassword() {
        return passwordHash;
    }

    @Override
    public String getUsername() {
        return email;
    }

    @Override
    public String toString() {
        return "AuthUser[id=" + id + ", email=" + email + ", role=" + role + "]";
    }
}
~~~

~~~java src/main/java/com/example/taskflow/security/JwtProperties.java
package com.example.taskflow.security;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "app.jwt")
public record JwtProperties(@NotBlank String secret, @NotNull Duration expiration) {
}
~~~

~~~java src/main/java/com/example/taskflow/security/JwtService.java
package com.example.taskflow.security;

import com.example.taskflow.user.Role;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;

@Service
public class JwtService {

    private static final String ISSUER = "taskflow";
    private final SecretKey key;
    private final Duration expiration;

    public JwtService(JwtProperties properties) {
        this.key = Keys.hmacShaKeyFor(Decoders.BASE64.decode(properties.secret()));
        this.expiration = properties.expiration();
    }

    public String generateToken(AuthUser user) {
        Instant now = Instant.now();
        return Jwts.builder()
                .issuer(ISSUER)
                .subject(String.valueOf(user.id()))
                .claim("email", user.email())
                .claim("role", user.role().name())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(expiration)))
                .signWith(key)
                .compact();
    }

    /** Returns the principal if the token is valid, empty otherwise. Never throws for bad tokens. */
    public Optional<AuthUser> parse(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(key)
                    .requireIssuer(ISSUER)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return Optional.of(new AuthUser(
                    Long.valueOf(claims.getSubject()),
                    claims.get("email", String.class),
                    "",
                    Role.valueOf(claims.get("role", String.class))));
        } catch (JwtException | IllegalArgumentException ex) {
            return Optional.empty();
        }
    }

    public Duration getExpiration() {
        return expiration;
    }
}
~~~

^javax.crypto^ is part of the JDK, not the old Java EE namespace, so it is correct here. ^Keys.hmacShaKeyFor^ throws at startup if the decoded secret is shorter than 256 bits: another fail-fast guarantee. Generate a real secret with ^openssl rand -base64 48^.

~~~java src/main/java/com/example/taskflow/security/JwtAuthFilter.java
package com.example.taskflow.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

@Component
public class JwtAuthFilter extends OncePerRequestFilter {

    private static final String PREFIX = "Bearer ";
    private final JwtService jwtService;

    public JwtAuthFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header != null && header.startsWith(PREFIX)) {
            jwtService.parse(header.substring(PREFIX.length())).ifPresent(user -> {
                var auth = new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities());
                auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContext context = SecurityContextHolder.createEmptyContext();
                context.setAuthentication(auth);
                SecurityContextHolder.setContext(context);
            });
        }
        chain.doFilter(request, response);
    }
}
~~~

An invalid token is simply ignored: the request continues anonymously and the authorization rules return 401 if the endpoint needs auth. The filter never decides access itself, which keeps responsibilities clean. Notice we trust the role inside the token instead of querying the DB on every request; that is the stateless trade-off (a demoted admin keeps admin rights until the token expires).

~~~java src/main/java/com/example/taskflow/security/DbUserDetailsService.java
package com.example.taskflow.security;

import com.example.taskflow.user.UserRepository;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;

@Service
public class DbUserDetailsService implements UserDetailsService {

    private final UserRepository userRepository;

    public DbUserDetailsService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public UserDetails loadUserByUsername(String email) {
        return userRepository.findByEmailIgnoreCase(email)
                .map(u -> new AuthUser(u.getId(), u.getEmail(), u.getPasswordHash(), u.getRole()))
                .orElseThrow(() -> new UsernameNotFoundException("User not found"));
    }
}
~~~

~~~java src/main/java/com/example/taskflow/security/CurrentUser.java
package com.example.taskflow.security;

import org.springframework.security.authentication.AuthenticationCredentialsNotFoundException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

public final class CurrentUser {

    private CurrentUser() {
    }

    public static AuthUser get() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !(auth.getPrincipal() instanceof AuthUser user)) {
            throw new AuthenticationCredentialsNotFoundException("No authenticated user");
        }
        return user;
    }
}
~~~

### Step 6 - Security configuration

~~~java src/main/java/com/example/taskflow/security/SecurityConfig.java
package com.example.taskflow.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

import java.io.IOException;

@Configuration
@EnableMethodSecurity
@EnableConfigurationProperties(JwtProperties.class)
public class SecurityConfig {

    private final JwtAuthFilter jwtAuthFilter;
    private final ObjectMapper objectMapper;

    public SecurityConfig(JwtAuthFilter jwtAuthFilter, ObjectMapper objectMapper) {
        this.jwtAuthFilter = jwtAuthFilter;
        this.objectMapper = objectMapper;
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        return http
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login").permitAll()
                        .requestMatchers("/actuator/health/**", "/actuator/info").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        .requestMatchers("/api/admin/**").hasRole("ADMIN")
                        .requestMatchers("/api/**").authenticated()
                        .anyRequest().denyAll())
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint((req, res, e) ->
                                writeProblem(res, HttpStatus.UNAUTHORIZED, "Authentication required"))
                        .accessDeniedHandler((req, res, e) ->
                                writeProblem(res, HttpStatus.FORBIDDEN, "Access denied")))
                .addFilterBefore(jwtAuthFilter, UsernamePasswordAuthenticationFilter.class)
                .build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    AuthenticationManager authenticationManager(AuthenticationConfiguration config) throws Exception {
        return config.getAuthenticationManager();
    }

    private void writeProblem(HttpServletResponse res, HttpStatus status, String detail) throws IOException {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setProperty("requestId", org.slf4j.MDC.get("requestId"));
        res.setStatus(status.value());
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(res.getOutputStream(), pd);
    }
}
~~~

Why each line:

- **CSRF disabled** is safe *only* because we use bearer tokens in a header, not cookies. Browsers attach cookies automatically (that is what CSRF exploits); they never attach an Authorization header by themselves.
- **STATELESS** stops Spring creating an HTTP session per request.
- **^anyRequest().denyAll()^** is a secure default: a forgotten endpoint outside ^/api^ is closed, not open.
- **^@EnableMethodSecurity^** activates ^@PreAuthorize^ (it replaces the deprecated ^@EnableGlobalMethodSecurity^).
- **AuthenticationManager from AuthenticationConfiguration:** Boot sees our ^UserDetailsService^ and ^PasswordEncoder^ beans and builds a ^DaoAuthenticationProvider^ automatically.
- Because ^JwtAuthFilter^ is a ^@Component^, Boot would *also* register it as a plain servlet filter, running it twice. Add the bean below to prevent that.

~~~java src/main/java/com/example/taskflow/security/FilterRegistrationConfig.java
package com.example.taskflow.security;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class FilterRegistrationConfig {

    /** JwtAuthFilter runs inside the security chain only, not as a second servlet filter. */
    @Bean
    FilterRegistrationBean<JwtAuthFilter> jwtFilterRegistration(JwtAuthFilter filter) {
        FilterRegistrationBean<JwtAuthFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }
}
~~~

### Step 7 - Ownership bean for @PreAuthorize

~~~java src/main/java/com/example/taskflow/security/ProjectSecurity.java
package com.example.taskflow.security;

import com.example.taskflow.project.ProjectRepository;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/** Referenced from SpEL as @projectSecurity. */
@Component("projectSecurity")
public class ProjectSecurity {

    private final ProjectRepository projectRepository;

    public ProjectSecurity(ProjectRepository projectRepository) {
        this.projectRepository = projectRepository;
    }

    @Transactional(readOnly = true)
    public boolean isOwnerOrAdmin(Long projectId) {
        AuthUser user = CurrentUser.get();
        if (user.isAdmin()) {
            return true;
        }
        // Missing project -> allow, so the service can answer 404 instead of a misleading 403
        return !projectRepository.existsById(projectId)
                || projectRepository.existsByIdAndOwnerId(projectId, user.id());
    }
}
~~~

### Step 8 - Project feature: DTOs, mapper, service, controller

~~~java src/main/java/com/example/taskflow/project/dto/ProjectRequest.java
package com.example.taskflow.project.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ProjectRequest(
        @NotBlank @Size(max = 120) String name,
        @Size(max = 2000) String description) {
}
~~~

~~~java src/main/java/com/example/taskflow/project/dto/ProjectResponse.java
package com.example.taskflow.project.dto;

import java.time.Instant;

public record ProjectResponse(Long id, String name, String description, Long ownerId, String ownerEmail,
                              Instant createdAt, Instant updatedAt) {
}
~~~

~~~java src/main/java/com/example/taskflow/project/ProjectMapper.java
package com.example.taskflow.project;

import com.example.taskflow.project.dto.ProjectResponse;
import org.springframework.stereotype.Component;

@Component
public class ProjectMapper {

    public ProjectResponse toResponse(Project p) {
        return new ProjectResponse(p.getId(), p.getName(), p.getDescription(),
                p.getOwner().getId(), p.getOwner().getEmail(), p.getCreatedAt(), p.getUpdatedAt());
    }
}
~~~

Hand-written mappers are explicit and debuggable. MapStruct generates the same code at compile time and is a fine choice in bigger teams; avoid reflection-based mappers (ModelMapper) in hot paths, as they hide mistakes until runtime.

~~~java src/main/java/com/example/taskflow/project/ProjectService.java
package com.example.taskflow.project;

import com.example.taskflow.common.ResourceNotFoundException;
import com.example.taskflow.project.dto.ProjectRequest;
import com.example.taskflow.project.dto.ProjectResponse;
import com.example.taskflow.security.AuthUser;
import com.example.taskflow.security.CurrentUser;
import com.example.taskflow.user.User;
import com.example.taskflow.user.UserRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class ProjectService {

    private final ProjectRepository projectRepository;
    private final UserRepository userRepository;
    private final ProjectMapper mapper;

    public ProjectService(ProjectRepository projectRepository, UserRepository userRepository, ProjectMapper mapper) {
        this.projectRepository = projectRepository;
        this.userRepository = userRepository;
        this.mapper = mapper;
    }

    public Page<ProjectResponse> list(Pageable pageable) {
        AuthUser me = CurrentUser.get();
        Page<Project> page = me.isAdmin()
                ? projectRepository.findAllWithOwner(pageable)
                : projectRepository.findByOwnerId(me.id(), pageable);
        return page.map(mapper::toResponse);
    }

    public ProjectResponse get(Long id) {
        return mapper.toResponse(load(id));
    }

    @Transactional
    public ProjectResponse create(ProjectRequest request) {
        User owner = userRepository.getReferenceById(CurrentUser.get().id());
        Project saved = projectRepository.save(new Project(request.name(), request.description(), owner));
        return mapper.toResponse(projectRepository.findWithOwnerById(saved.getId()).orElseThrow());
    }

    @Transactional
    public ProjectResponse update(Long id, ProjectRequest request) {
        Project project = load(id);
        project.rename(request.name(), request.description());
        return mapper.toResponse(project);
    }

    @Transactional
    public void delete(Long id) {
        projectRepository.delete(load(id));
    }

    /** Used by TaskService; ownership must already have been checked by the caller. */
    public Project load(Long id) {
        return projectRepository.findWithOwnerById(id)
                .orElseThrow(() -> new ResourceNotFoundException("Project", id));
    }
}
~~~

^getReferenceById^ returns a proxy without a SELECT: we only need the foreign key to insert the project. Class-level ^readOnly = true^ with method-level ^@Transactional^ on writes is a clean default: forgetting the annotation on a new write method fails loudly in tests instead of silently skipping the flush.

~~~java src/main/java/com/example/taskflow/project/ProjectController.java
package com.example.taskflow.project;

import com.example.taskflow.common.PageResponse;
import com.example.taskflow.project.dto.ProjectRequest;
import com.example.taskflow.project.dto.ProjectResponse;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;

@RestController
@RequestMapping("/api/projects")
@Tag(name = "Projects")
@SecurityRequirement(name = "bearerAuth")
public class ProjectController {

    private final ProjectService projectService;

    public ProjectController(ProjectService projectService) {
        this.projectService = projectService;
    }

    @GetMapping
    @Operation(summary = "List my projects (all projects for admins)")
    public PageResponse<ProjectResponse> list(
            @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC) Pageable pageable) {
        return PageResponse.from(projectService.list(pageable));
    }

    @GetMapping("/{projectId}")
    @PreAuthorize("@projectSecurity.isOwnerOrAdmin(#projectId)")
    public ProjectResponse get(@PathVariable Long projectId) {
        return projectService.get(projectId);
    }

    @PostMapping
    public ResponseEntity<ProjectResponse> create(@Valid @RequestBody ProjectRequest request) {
        ProjectResponse created = projectService.create(request);
        URI location = ServletUriComponentsBuilder.fromCurrentRequest()
                .path("/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }

    @PutMapping("/{projectId}")
    @PreAuthorize("@projectSecurity.isOwnerOrAdmin(#projectId)")
    public ProjectResponse update(@PathVariable Long projectId, @Valid @RequestBody ProjectRequest request) {
        return projectService.update(projectId, request);
    }

    @DeleteMapping("/{projectId}")
    @PreAuthorize("@projectSecurity.isOwnerOrAdmin(#projectId)")
    public ResponseEntity<Void> delete(@PathVariable Long projectId) {
        projectService.delete(projectId);
        return ResponseEntity.noContent().build();
    }
}
~~~

### Step 9 - Task feature: DTOs and mapper

~~~java src/main/java/com/example/taskflow/task/dto/TaskCreateRequest.java
package com.example.taskflow.task.dto;

import com.example.taskflow.task.TaskPriority;
import jakarta.validation.constraints.FutureOrPresent;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;

public record TaskCreateRequest(
        @NotBlank @Size(max = 200) String title,
        @Size(max = 4000) String description,
        TaskPriority priority,
        @FutureOrPresent LocalDate dueDate,
        Long assigneeId) {
}
~~~

~~~java src/main/java/com/example/taskflow/task/dto/TaskUpdateRequest.java
package com.example.taskflow.task.dto;

import com.example.taskflow.task.TaskPriority;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;

public record TaskUpdateRequest(
        @NotBlank @Size(max = 200) String title,
        @Size(max = 4000) String description,
        @NotNull TaskPriority priority,
        LocalDate dueDate,
        Long assigneeId,
        @NotNull(message = "version is required for optimistic locking") Long version) {
}
~~~

~~~java src/main/java/com/example/taskflow/task/dto/TaskStatusRequest.java
package com.example.taskflow.task.dto;

import com.example.taskflow.task.TaskStatus;
import jakarta.validation.constraints.NotNull;

public record TaskStatusRequest(@NotNull TaskStatus status, @NotNull Long version) {
}
~~~

~~~java src/main/java/com/example/taskflow/task/dto/TaskResponse.java
package com.example.taskflow.task.dto;

import com.example.taskflow.task.TaskPriority;
import com.example.taskflow.task.TaskStatus;

import java.time.Instant;
import java.time.LocalDate;

public record TaskResponse(Long id, String title, String description, TaskStatus status, TaskPriority priority,
                           LocalDate dueDate, Long projectId, Long assigneeId, String assigneeEmail,
                           Long version, Instant createdAt, Instant updatedAt) {
}
~~~

~~~java src/main/java/com/example/taskflow/task/dto/TaskFilter.java
package com.example.taskflow.task.dto;

import com.example.taskflow.task.TaskPriority;
import com.example.taskflow.task.TaskStatus;

/** Bound from query parameters: ?status=TODO&priority=HIGH&assigneeId=3 */
public record TaskFilter(TaskStatus status, TaskPriority priority, Long assigneeId) {
}
~~~

Note that ^@FutureOrPresent^ is on create only: when updating an old task its due date may legitimately be in the past.

~~~java src/main/java/com/example/taskflow/task/TaskMapper.java
package com.example.taskflow.task;

import com.example.taskflow.task.dto.TaskResponse;
import com.example.taskflow.user.User;
import org.springframework.stereotype.Component;

@Component
public class TaskMapper {

    public TaskResponse toResponse(Task t) {
        User a = t.getAssignee();
        return new TaskResponse(t.getId(), t.getTitle(), t.getDescription(), t.getStatus(), t.getPriority(),
                t.getDueDate(), t.getProject().getId(),
                a != null ? a.getId() : null, a != null ? a.getEmail() : null,
                t.getVersion(), t.getCreatedAt(), t.getUpdatedAt());
    }
}
~~~

### Step 10 - TaskService: the heart of the app

~~~java src/main/java/com/example/taskflow/task/TaskService.java
package com.example.taskflow.task;

import com.example.taskflow.common.ResourceNotFoundException;
import com.example.taskflow.project.Project;
import com.example.taskflow.project.ProjectService;
import com.example.taskflow.security.AuthUser;
import com.example.taskflow.security.CurrentUser;
import com.example.taskflow.task.dto.TaskCreateRequest;
import com.example.taskflow.task.dto.TaskFilter;
import com.example.taskflow.task.dto.TaskResponse;
import com.example.taskflow.task.dto.TaskStatusRequest;
import com.example.taskflow.task.dto.TaskUpdateRequest;
import com.example.taskflow.user.User;
import com.example.taskflow.user.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import static com.example.taskflow.task.TaskSpecifications.assignedTo;
import static com.example.taskflow.task.TaskSpecifications.hasPriority;
import static com.example.taskflow.task.TaskSpecifications.hasStatus;
import static com.example.taskflow.task.TaskSpecifications.inProject;

@Service
@Transactional(readOnly = true)
public class TaskService {

    private static final Logger log = LoggerFactory.getLogger(TaskService.class);

    private final TaskRepository taskRepository;
    private final ProjectService projectService;
    private final UserRepository userRepository;
    private final TaskMapper mapper;

    public TaskService(TaskRepository taskRepository, ProjectService projectService,
                       UserRepository userRepository, TaskMapper mapper) {
        this.taskRepository = taskRepository;
        this.projectService = projectService;
        this.userRepository = userRepository;
        this.mapper = mapper;
    }

    public Page<TaskResponse> list(Long projectId, TaskFilter filter, Pageable pageable) {
        Project project = projectService.load(projectId);
        requireProjectOwnerOrAdmin(project);
        Specification<Task> spec = Specification.where(inProject(projectId))
                .and(hasStatus(filter.status()))
                .and(hasPriority(filter.priority()))
                .and(assignedTo(filter.assigneeId()));
        return taskRepository.findAll(spec, pageable).map(mapper::toResponse);
    }

    public TaskResponse get(Long taskId) {
        Task task = load(taskId);
        requireOwnerAssigneeOrAdmin(task);
        return mapper.toResponse(task);
    }

    @Transactional
    public TaskResponse create(Long projectId, TaskCreateRequest req) {
        Project project = projectService.load(projectId);
        requireProjectOwnerOrAdmin(project);
        Task task = new Task(req.title(), req.description(), req.priority(), req.dueDate(),
                project, resolveAssignee(req.assigneeId()));
        Task saved = taskRepository.saveAndFlush(task);
        log.info("Task {} created in project {}", saved.getId(), projectId);
        return mapper.toResponse(saved);
    }

    @Transactional
    public TaskResponse update(Long taskId, TaskUpdateRequest req) {
        Task task = load(taskId);
        requireProjectOwnerOrAdmin(task.getProject());
        checkVersion(task, req.version());
        task.update(req.title(), req.description(), req.priority(), req.dueDate(), resolveAssignee(req.assigneeId()));
        taskRepository.flush(); // forces the versioned UPDATE now, so the response carries the new version
        return mapper.toResponse(task);
    }

    @Transactional
    public TaskResponse changeStatus(Long taskId, TaskStatusRequest req) {
        Task task = load(taskId);
        requireOwnerAssigneeOrAdmin(task);
        checkVersion(task, req.version());
        task.changeStatus(req.status());
        taskRepository.flush();
        return mapper.toResponse(task);
    }

    @Transactional
    public void delete(Long taskId) {
        Task task = load(taskId);
        requireProjectOwnerOrAdmin(task.getProject());
        taskRepository.delete(task);
    }

    // ---------- helpers ----------

    private Task load(Long taskId) {
        return taskRepository.findWithDetailsById(taskId)
                .orElseThrow(() -> new ResourceNotFoundException("Task", taskId));
    }

    private User resolveAssignee(Long assigneeId) {
        if (assigneeId == null) {
            return null;
        }
        return userRepository.findById(assigneeId)
                .orElseThrow(() -> new ResourceNotFoundException("User", assigneeId));
    }

    private void checkVersion(Task task, Long clientVersion) {
        if (!task.getVersion().equals(clientVersion)) {
            throw new ObjectOptimisticLockingFailureException(Task.class, task.getId());
        }
    }

    private void requireProjectOwnerOrAdmin(Project project) {
        AuthUser me = CurrentUser.get();
        if (!me.isAdmin() && !project.isOwnedBy(me.id())) {
            throw new AccessDeniedException("Not the project owner");
        }
    }

    private void requireOwnerAssigneeOrAdmin(Task task) {
        AuthUser me = CurrentUser.get();
        if (!me.isAdmin() && !task.getProject().isOwnedBy(me.id()) && !task.isAssignedTo(me.id())) {
            throw new AccessDeniedException("Not allowed to access this task");
        }
    }
}
~~~

Walk through ^update^ as Hibernate sees it:

1. ^findWithDetailsById^: one SELECT joining project, owner and assignee. The entity is now **managed** and a snapshot is stored in the persistence context.
2. Ownership check in memory. No extra query.
3. Version check: fast fail for the common conflict.
4. ^task.update(...)^ only changes Java fields.
5. ^flush()^: dirty checking finds changes and runs ^update tasks set ..., version=4 where id=42 and version=3^. Zero rows would throw.
6. The mapper reads the new version 4, which the client must send next time.
7. The proxy commits on return. Because our service is called from the controller (through the proxy), all of this is one transaction.

Why does ^update^ throw ^AccessDeniedException^ from a service and still give 403? It propagates out of the controller into the DispatcherServlet's exception resolution, where our ^@RestControllerAdvice^ maps it.

### Step 11 - TaskController with filtering, sorting, paging

~~~java src/main/java/com/example/taskflow/task/TaskController.java
package com.example.taskflow.task;

import com.example.taskflow.common.PageResponse;
import com.example.taskflow.task.dto.TaskCreateRequest;
import com.example.taskflow.task.dto.TaskFilter;
import com.example.taskflow.task.dto.TaskResponse;
import com.example.taskflow.task.dto.TaskStatusRequest;
import com.example.taskflow.task.dto.TaskUpdateRequest;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.net.URI;
import java.util.Set;

@RestController
@Tag(name = "Tasks")
@SecurityRequirement(name = "bearerAuth")
public class TaskController {

    private static final Set<String> SORTABLE = Set.of("createdAt", "dueDate", "priority", "status", "title");
    private final TaskService taskService;

    public TaskController(TaskService taskService) {
        this.taskService = taskService;
    }

    @GetMapping("/api/projects/{projectId}/tasks")
    @Operation(summary = "List tasks of a project",
            description = "Filter with status, priority, assigneeId. Sort e.g. sort=dueDate,asc&sort=priority,desc")
    public PageResponse<TaskResponse> list(
            @PathVariable Long projectId,
            @ParameterObject TaskFilter filter,
            @ParameterObject @PageableDefault(size = 20, sort = "createdAt", direction = Sort.Direction.DESC)
            Pageable pageable) {
        validateSort(pageable.getSort());
        return PageResponse.from(taskService.list(projectId, filter, pageable));
    }

    @PostMapping("/api/projects/{projectId}/tasks")
    public ResponseEntity<TaskResponse> create(@PathVariable Long projectId,
                                               @Valid @RequestBody TaskCreateRequest request) {
        TaskResponse created = taskService.create(projectId, request);
        URI location = ServletUriComponentsBuilder.fromCurrentContextPath()
                .path("/api/tasks/{id}").buildAndExpand(created.id()).toUri();
        return ResponseEntity.created(location).body(created);
    }

    @GetMapping("/api/tasks/{taskId}")
    public TaskResponse get(@PathVariable Long taskId) {
        return taskService.get(taskId);
    }

    @PutMapping("/api/tasks/{taskId}")
    @Operation(summary = "Replace a task", description = "Requires the current version; returns 409 on conflict")
    public TaskResponse update(@PathVariable Long taskId, @Valid @RequestBody TaskUpdateRequest request) {
        return taskService.update(taskId, request);
    }

    @PatchMapping("/api/tasks/{taskId}/status")
    public TaskResponse changeStatus(@Parameter(description = "Task id") @PathVariable Long taskId,
                                     @Valid @RequestBody TaskStatusRequest request) {
        return taskService.changeStatus(taskId, request);
    }

    @DeleteMapping("/api/tasks/{taskId}")
    public ResponseEntity<Void> delete(@PathVariable Long taskId) {
        taskService.delete(taskId);
        return ResponseEntity.noContent().build();
    }

    private void validateSort(Sort sort) {
        sort.forEach(order -> {
            if (!SORTABLE.contains(order.getProperty())) {
                throw new IllegalArgumentException("Cannot sort by " + order.getProperty());
            }
        });
    }
}
~~~

**Magic under the hood:** ^TaskFilter^ is a record without annotations, so Spring MVC treats it as a ^@ModelAttribute^: it calls the canonical constructor with query params matched by name and converts ^"HIGH"^ to the enum via the ^ConversionService^. ^Pageable^ is resolved by ^PageableHandlerMethodArgumentResolver^ from ^page^, ^size^ and ^sort^. Whitelisting sort properties prevents clients sorting on unindexed or internal fields (and odd JPQL paths). Add this handler to map that ^IllegalArgumentException^ to 400:

~~~java src/main/java/com/example/taskflow/common/BadRequestAdvice.java
package com.example.taskflow.common;

import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class BadRequestAdvice {

    @ExceptionHandler(IllegalArgumentException.class)
    ProblemDetail handleIllegalArgument(IllegalArgumentException ex) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
        pd.setTitle("Bad request");
        pd.setProperty("requestId", MDC.get(RequestIdFilter.MDC_KEY));
        return pd;
    }
}
~~~

Also cap page size so nobody can request a million rows:

~~~yaml src/main/resources/application.yml (add under spring:)
  data:
    web:
      pageable:
        max-page-size: 100
~~~

### Step 12 - OpenAPI configuration

~~~java src/main/java/com/example/taskflow/common/OpenApiConfig.java
package com.example.taskflow.common;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType;
import io.swagger.v3.oas.annotations.info.Info;
import io.swagger.v3.oas.annotations.security.SecurityScheme;
import org.springframework.context.annotation.Configuration;

@Configuration
@OpenAPIDefinition(info = @Info(title = "TaskFlow API", version = "v1",
        description = "Task management backend: projects, tasks, JWT auth"))
@SecurityScheme(name = "bearerAuth", type = SecuritySchemeType.HTTP, scheme = "bearer", bearerFormat = "JWT")
public class OpenApiConfig {
}
~~~

springdoc inspects your ^@RestController^ mappings, parameter types, Bean Validation annotations (^@Size(max=200)^ becomes ^maxLength: 200^) and records at startup, and serves the spec at ^/v3/api-docs^ and the UI at ^/swagger-ui.html^. Click **Authorize**, paste the token, and try endpoints in the browser.

### Step 13 - Try the whole flow

~~~powershell
# 1. Register and log in
curl -s -X POST localhost:8080/api/auth/register -H "Content-Type: application/json" -d '{"email":"julian@example.com","password":"supersecret"}'
$TOKEN = (curl -s -X POST localhost:8080/api/auth/login -H "Content-Type: application/json" -d '{"email":"julian@example.com","password":"supersecret"}' | ConvertFrom-Json).accessToken

# 2. Create a project and a task
curl -s -i -X POST localhost:8080/api/projects -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Capstone","description":"Build TaskFlow"}'
curl -s -X POST localhost:8080/api/projects/1/tasks -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"title":"Write migrations","priority":"HIGH","dueDate":"2026-12-31"}'

# 3. Filter and sort
curl -s "localhost:8080/api/projects/1/tasks?status=TODO&priority=HIGH&sort=dueDate,asc&size=10" -H "Authorization: Bearer $TOKEN"

# 4. Update with a stale version -> 409
curl -s -X PATCH localhost:8080/api/tasks/1/status -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"status":"IN_PROGRESS","version":0}'
curl -s -X PATCH localhost:8080/api/tasks/1/status -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"status":"DONE","version":0}'
~~~

Expected for the second PATCH:

~~~json
{
  "type": "https://taskflow.example.com/problems/conflict",
  "title": "Concurrent modification",
  "status": 409,
  "detail": "The resource was modified by someone else. Reload it and apply your change again.",
  "instance": "/api/tasks/1/status",
  "requestId": "6f1c2a8e-3b7d-4c09-9a51-2d0f6e7b8c11"
}
~~~

And a validation error (empty title):

~~~json
{
  "type": "https://taskflow.example.com/problems/validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "One or more fields are invalid",
  "errors": { "title": "must not be blank" },
  "requestId": "0b9d..."
}
~~~

Register a second user, log in as them and request ^GET /api/projects/1^: you get **403**. Log in as ^admin@taskflow.dev^ and the same call returns 200. Your log lines now look like ^INFO [6f1c2a8e-...] c.e.taskflow.task.TaskService : Task 1 created in project 1^.

---

## 3. Common Pitfalls & Best Practices

- **Returning entities from controllers.** Leaks ^passwordHash^, triggers ^LazyInitializationException^ with open-in-view off, and couples your API to your schema. Fix: map to records inside the transactional service.
- **Trusting IDs from the client for ownership** (e.g. ^ownerId^ in the request body). Fix: always derive the user from the ^SecurityContext^ and check ownership on the server.
- **Ignoring the version on updates.** Without it, last write silently wins. Fix: require ^version^ in PUT/PATCH bodies, compare it, and map lock failures to 409.
- **Calling a ^@Transactional^ method from the same class.** The proxy is bypassed and no transaction starts. Fix: put the transactional boundary on the public method called from outside, or split classes.
- **Registering the JWT filter twice.** A ^@Component^ filter is auto-added to the servlet container too. Fix: disable its ^FilterRegistrationBean^ as shown.
- **Leaking internals in 500 responses.** Stack traces help attackers. Fix: generic message plus ^requestId^, full stack trace only in logs.
- **Unbounded or arbitrary sorting and paging.** Clients can request huge pages or sort on unindexed columns. Fix: ^max-page-size^ and a sort whitelist.
- **Forgetting to clear MDC.** Thread reuse attaches one user's request id to another's logs. Fix: ^MDC.remove^ in ^finally^.

---

## 4. Hands-On Practice

Complete the milestones below on your own. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Make the API layer yours","tasks":["Implement every file from this lesson, then move the repository usage out of ^AdminUserController^ into a new ^UserService^ with ^@Transactional(readOnly = true)^.","Acceptance: the curl flow in Step 13 works end to end, a second user gets 403 on the first user's project, and the admin gets 200.","Acceptance: two PATCH calls with the same version produce 200 then 409, and every error body contains a ^requestId^ that also appears in the server log line.","Open ^/swagger-ui.html^, authorize with a token and execute ^GET /api/projects/{projectId}/tasks^ with filters from the UI."]},
{"title":"Exercise 2 (Challenge): Milestone - Comment feature API","tasks":["Using the V3 migration and entity from Lesson 7.1, expose ^GET /api/tasks/{taskId}/comments^ (paged, newest first) and ^POST /api/tasks/{taskId}/comments^ (201 + Location).","Rules: anyone who may read the task may read and add comments; only the comment author or an ADMIN may delete with ^DELETE /api/comments/{id}^ (204).","Validation: body is required, 1-2000 characters; errors must use the existing ProblemDetail format.","Map ^DataIntegrityViolationException^ on ^uk_users_email^ to 409 so concurrent duplicate registrations do not return 500.","Acceptance: the endpoints appear in Swagger with the bearer lock icon and a non-owner gets 403."]},
{"title":"Exercise 3 (Challenge): Milestone - soft delete and smarter authorization","tasks":["Add soft delete for tasks: a ^deleted_at^ column via a new Flyway migration, DELETE sets it instead of removing the row, and all queries exclude deleted tasks (research Hibernate ^@SQLRestriction^ and decide whether to use it).","Acceptance: a deleted task returns 404 on GET, disappears from lists, and still exists in the database.","Replace the service-level task ownership checks with a ^@taskSecurity^ bean used in ^@PreAuthorize^, then write down which approach you prefer and why (queries per request, testability, readability).","Read the Spring Security reference on method security and explain in your notes when ^@PostAuthorize^ would be appropriate and why it is risky for write operations."]}
]
};
