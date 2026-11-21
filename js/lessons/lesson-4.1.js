LESSONS['4.1']={
md:String.raw`## 1. Concept & Theory

> **Where the project stands:** after Module 3, the Bookstore API is a real persistence-backed service. ^Book^, ^Author^ and ^Category^ are JPA entities stored in PostgreSQL (H2 for quick runs), ^BookRepository^ supports derived queries, JPQL and paging, and ^GlobalExceptionHandler^ turns errors into ^ProblemDetail^ JSON. The problem: **anyone on the network can delete every book**. In this lesson we add Spring Security, users stored in the database, BCrypt passwords and HTTP Basic authentication. Lesson 4.2 replaces Basic with stateless JWT and adds role-based rules.

### 1.1 Authentication vs Authorization

Two words that sound alike and are constantly confused in interviews and in code reviews:

| Question | Name | Failure status | Example |
|---|---|---|---|
| Who are you? | Authentication (AuthN) | 401 Unauthorized | Wrong password, missing credentials, expired token |
| What are you allowed to do? | Authorization (AuthZ) | 403 Forbidden | Logged-in user tries to delete a book but is not an admin |

**Analogy:** an office building. At the front desk you show your ID card; the guard checks it is genuine and that it is yours. That is authentication. Then your badge opens the floors you work on but not the server room. That is authorization. A guard that lets everyone in who *claims* to be the CEO has broken authentication; a badge that opens the server room for an intern has broken authorization. Both are on the OWASP Top 10 ("Broken Access Control" is number one).

Note the confusing naming in HTTP: status 401 is called "Unauthorized" but it really means "unauthenticated". Status 403 "Forbidden" means "I know who you are, and the answer is still no."

### 1.2 Where Spring Security lives: the servlet filter chain

Spring MVC's ^DispatcherServlet^ is the entry point for your controllers. But before a request reaches any servlet, it passes through a chain of **servlet filters** managed by the embedded Tomcat. A filter can inspect the request, modify it, short-circuit it (respond immediately) or pass it on with ^chain.doFilter(request, response)^.

Spring Security is, at its core, **a set of servlet filters**. It does not touch your controllers at all (method security, covered in 4.2, is the exception). That is why it can protect anything: controllers, static files, Actuator endpoints, even error pages.

The problem: Tomcat creates filters itself and knows nothing about Spring beans. Spring solves this with three layers of indirection:

| Component | Who creates it | Job |
|---|---|---|
| DelegatingFilterProxy | Registered with the servlet container (Boot does it automatically) | A plain servlet filter that looks up a Spring bean named springSecurityFilterChain and delegates to it. The bridge between Tomcat and the Spring context. |
| FilterChainProxy | Spring bean (springSecurityFilterChain) | Holds one or more SecurityFilterChain objects. For each request, picks the FIRST chain whose matcher fits and runs its filters. Also clears the SecurityContext after the request, and applies the HttpFirewall. |
| SecurityFilterChain | Your @Bean (built with HttpSecurity) | An ordered list of security filters, plus a request matcher deciding which requests it applies to. |

~~~text
HTTP request
   |
Tomcat filter chain
   |-- CharacterEncodingFilter, ...
   |-- DelegatingFilterProxy ("springSecurityFilterChain")
   |        |
   |        FilterChainProxy
   |           |-- SecurityFilterChain #1 (e.g. /actuator/**)  -> not matched
   |           |-- SecurityFilterChain #2 (any request)        -> matched, runs:
   |                  DisableEncodeUrlFilter
   |                  SecurityContextHolderFilter
   |                  HeaderWriterFilter
   |                  CorsFilter
   |                  CsrfFilter
   |                  LogoutFilter
   |                  UsernamePasswordAuthenticationFilter (form login)
   |                  BasicAuthenticationFilter               <- HTTP Basic
   |                  RequestCacheAwareFilter
   |                  SecurityContextHolderAwareRequestFilter
   |                  AnonymousAuthenticationFilter
   |                  ExceptionTranslationFilter              <- turns exceptions into 401/403
   |                  AuthorizationFilter                     <- checks your rules
   |
DispatcherServlet -> BookController
~~~

You do not need to memorize the list, but two filters matter a lot:

- **ExceptionTranslationFilter** catches ^AuthenticationException^ (calls the ^AuthenticationEntryPoint^, normally a 401) and ^AccessDeniedException^ (calls the ^AccessDeniedHandler^, a 403 for authenticated users, or the entry point for anonymous users).
- **AuthorizationFilter** is last: it checks the rules you wrote in ^authorizeHttpRequests^ against the current ^Authentication^.

**Debugging tip:** set ^logging.level.org.springframework.security=TRACE^ and Spring prints every filter it runs for each request. When "it returns 401 and I don't know why", this is your first move.

### 1.3 SecurityContextHolder and Authentication

After a filter authenticates someone, where is that fact stored? In the **SecurityContextHolder**, which by default uses a ^ThreadLocal^. Since a classic servlet request is handled by a single thread from start to finish, any code on that thread (service, repository, a logger) can ask "who is the current user?".

~~~java
Authentication auth = SecurityContextHolder.getContext().getAuthentication();
String username = auth.getName();
~~~

An ^Authentication^ object has two lives:

| Phase | principal | credentials | authorities | isAuthenticated |
|---|---|---|---|---|
| Before (a request to log in) | the username string | the raw password | empty | false |
| After (a successful result) | a UserDetails object | erased (null) | e.g. ROLE_USER | true |

The most common implementation is ^UsernamePasswordAuthenticationToken^. **Authorities** (^GrantedAuthority^) are just strings such as ^ROLE_ADMIN^ or ^book:write^ used by authorization rules.

Because the context is thread-bound, ^FilterChainProxy^ clears it at the end of every request, otherwise the next request served by the same pooled Tomcat thread would inherit the previous user. Never cache an ^Authentication^ in a static field or a singleton for this reason.

### 1.4 AuthenticationManager, ProviderManager, AuthenticationProvider

A filter like ^BasicAuthenticationFilter^ does not verify passwords itself. It extracts credentials, builds an unauthenticated token, and hands it to the **AuthenticationManager**:

~~~text
BasicAuthenticationFilter
   -> AuthenticationManager.authenticate(token)      (interface)
        = ProviderManager                            (default implementation)
             -> loops over AuthenticationProvider list
                  DaoAuthenticationProvider.supports(UsernamePasswordAuthenticationToken)? yes
                     -> UserDetailsService.loadUserByUsername("julian")
                     -> PasswordEncoder.matches(raw, storedHash)
                     -> checks enabled / locked / expired flags
                     -> returns authenticated token with authorities
   <- filter stores it in SecurityContextHolder
~~~

- **AuthenticationManager**: one method, ^authenticate(Authentication)^. Returns a fully authenticated object or throws ^AuthenticationException^ (e.g. ^BadCredentialsException^).
- **ProviderManager**: the default implementation. Holds a list of providers and asks each one "do you support this token type?". This is how one app can support passwords, LDAP and API keys at the same time.
- **AuthenticationProvider**: does the actual work for one kind of credential. For username and password that is **DaoAuthenticationProvider**.

### 1.5 UserDetails and UserDetailsService

^DaoAuthenticationProvider^ does not know your database. It only knows two interfaces:

- **UserDetailsService** with a single method ^loadUserByUsername(String)^, throwing ^UsernameNotFoundException^ if no user exists.
- **UserDetails**: the security view of a user: username, password hash, authorities, and four account flags (enabled, non-locked, non-expired, credentials non-expired).

This is the classic **adapter** pattern: you keep your own ^AppUser^ JPA entity and write a small adapter that converts it to a ^UserDetails^. Spring provides a ready-made immutable implementation, ^org.springframework.security.core.userdetails.User^, with a convenient builder.

### 1.6 PasswordEncoder, BCrypt, and why never plain text

Databases leak: SQL injection, stolen backups, a misconfigured S3 bucket, an insider. If passwords are stored in plain text, every user is compromised instantly, and because people reuse passwords, so are their email and bank accounts. Storing passwords in plain text is not a style issue; in many jurisdictions it is a legal liability (GDPR "appropriate technical measures").

Why not just SHA-256? Fast hashes are the problem: a modern GPU computes billions of SHA-256 hashes per second, so a leaked table of SHA-256 hashes is cracked with dictionaries in hours. Password hashing needs three properties:

| Property | Why | BCrypt |
|---|---|---|
| Slow on purpose | Makes brute force expensive | Cost factor (default strength 10 = 2 to the 10th rounds), tunable |
| Salted per user | Same password gives different hashes; rainbow tables useless | Random 16-byte salt embedded in the hash |
| Self-describing | Can upgrade algorithms later | Format: $2a$10$ + salt + hash, 60 characters |

~~~text
$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
 |   |  |---- 22 chars salt ----||------ 31 chars hash ------|
 |   cost factor (10)
 algorithm version
~~~

^passwordEncoder.matches(raw, hash)^ reads the salt and cost out of the stored hash, hashes the raw input the same way, and compares in constant time. You never "decrypt" a password; hashing is one-way.

Spring also offers ^PasswordEncoderFactories.createDelegatingPasswordEncoder()^, which stores hashes like ^{bcrypt}$2a$10$...^ and can verify several algorithms, ideal for migrating legacy systems. For a new project, a plain ^BCryptPasswordEncoder^ is perfectly fine and easier to read. Argon2 is a strong alternative if you want memory-hard hashing.

### 1.7 What happens the moment you add the starter

Add ^spring-boot-starter-security^ and restart. Without writing a single line, Spring Boot's ^SecurityAutoConfiguration^ and ^UserDetailsServiceAutoConfiguration^ kick in:

- **Every** endpoint now requires authentication (GET /api/books returns 401).
- An in-memory user named ^user^ is created, with a random password printed in the log: ^Using generated security password: 6f1c...^.
- Form login (a generated /login page) and HTTP Basic are both enabled.
- CSRF protection is ON, so POST/PUT/DELETE fail with 403 even with valid credentials.
- Security headers are added: ^X-Content-Type-Options: nosniff^, ^X-Frame-Options: DENY^, ^Cache-Control: no-cache, no-store^, HSTS on HTTPS.

This is "secure by default": forgetting configuration fails closed, not open. The moment you declare your own ^SecurityFilterChain^ bean, Boot backs off its default chain; the moment you declare a ^UserDetailsService^ bean, the generated user disappears. That is ^@ConditionalOnMissingBean^ at work, the same magic you saw for ^DataSource^ in Module 3.

### 1.8 Spring Security 6 configuration style

Old tutorials extend ^WebSecurityConfigurerAdapter^ and chain ^.and()^ calls. Both were **removed** in Spring Security 6 (Boot 3). The modern style is a ^@Bean^ method returning ^SecurityFilterChain^, configured with the **lambda DSL**:

~~~java
@Bean
SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
    http
        .authorizeHttpRequests(auth -> auth
            .requestMatchers(HttpMethod.GET, "/api/books/**").permitAll()
            .anyRequest().authenticated())
        .httpBasic(Customizer.withDefaults());
    return http.build();
}
~~~

Rules about ^requestMatchers^:

- Rules are evaluated **top to bottom, first match wins**. Put specific rules first and ^anyRequest()^ last (Spring throws an error if anything follows ^anyRequest^).
- Patterns use Ant style: ^/api/books/*^ matches one path segment, a double star matches any depth.
- You can match by HTTP method: ^requestMatchers(HttpMethod.DELETE, "/api/books/*")^.
- Prefer **deny by default**: end with ^anyRequest().authenticated()^ or ^denyAll()^, never ^permitAll()^.

### 1.9 HTTP Basic

HTTP Basic sends ^Authorization: Basic base64(username:password)^ on **every** request. Base64 is encoding, not encryption: anyone who sees the header has the password. Therefore Basic is acceptable only over **HTTPS**, and mostly for internal tools, machine-to-machine calls, and learning. Its benefits: zero ceremony, built into curl, Postman and browsers. Its cost: the server runs BCrypt (deliberately slow, around 50-100 ms) on every request, and the client must hold the raw password. Lesson 4.2 fixes both with tokens.

### 1.10 CSRF: what it is and when disabling is correct

**Cross-Site Request Forgery** exploits the fact that browsers automatically attach cookies. If you are logged into ^bank.com^ with a session cookie and visit ^evil.com^, a hidden form on evil.com can POST to ^bank.com/transfer^; your browser happily sends the cookie, and the bank sees a legitimate authenticated request.

Spring's defense: a random **CSRF token** that the server puts in the page and expects back in a header or form field. evil.com cannot read it (same-origin policy), so its forged request is rejected with 403.

**The key insight:** CSRF is only possible when the browser sends credentials **automatically** (cookies, and also browser-cached Basic credentials). Our Bookstore API is a **stateless** API consumed by clients that put credentials in the ^Authorization^ header explicitly on each call. A malicious site cannot make the browser add that header. Therefore:

| Client style | Credentials sent automatically? | CSRF protection |
|---|---|---|
| Server-rendered app with session cookie (Thymeleaf) | Yes | KEEP enabled |
| SPA using session cookies | Yes | KEEP enabled (CookieCsrfTokenRepository) |
| Stateless API with Authorization header (Basic or Bearer) | No | Safe to disable |
| JWT stored in a cookie | Yes | KEEP enabled (cookie = automatic) |

Disabling CSRF "because POST returned 403" without understanding this table is one of the most common security mistakes. We disable it **only** together with stateless sessions.

### 1.11 CORS

**Cross-Origin Resource Sharing** is a browser rule, not a server security feature. A React app at ^http://localhost:5173^ calling ^http://localhost:8080^ is "cross-origin"; the browser first sends an ^OPTIONS^ **preflight** asking "may this origin call you with these methods and headers?". If the server does not answer with the right ^Access-Control-Allow-*^ headers, the browser blocks the response. curl and Postman ignore CORS entirely, which is why "it works in Postman but not in the browser" is a classic CORS symptom.

Configure it inside Spring Security with ^http.cors(...)^ plus a ^CorsConfigurationSource^ bean, so the ^CorsFilter^ runs **before** authentication. Otherwise the preflight, which carries no credentials, is rejected with 401 and the browser reports a confusing CORS error.

### 1.12 401 vs 403 in practice

| Situation | Status | Produced by |
|---|---|---|
| No Authorization header on a protected endpoint | 401 | AuthenticationEntryPoint |
| Wrong password | 401 | AuthenticationEntryPoint |
| Valid user, rule requires ADMIN role | 403 | AccessDeniedHandler |
| POST with CSRF enabled and no token | 403 | AccessDeniedHandler (CSRF is an access decision) |

By default, Spring's Basic entry point returns 401 with ^WWW-Authenticate: Basic realm="Realm"^ and an empty body. Our API promises ^ProblemDetail^ JSON for every error (Lesson 2.3), so we will write a custom ^AuthenticationEntryPoint^ and ^AccessDeniedHandler^. Note: ^@RestControllerAdvice^ cannot handle these, because security exceptions happen in filters, **before** the ^DispatcherServlet^ runs.

---

## 2. Code Walkthrough

**New files:** ^security/SecurityConfig.java^ (evolves in two steps), ^model/AppUser.java^, ^model/Role.java^, ^repository/UserRepository.java^, ^security/AppUserDetailsService.java^, ^security/ProblemDetailAuthenticationEntryPoint.java^, ^security/ProblemDetailAccessDeniedHandler.java^, ^dto/RegisterRequest.java^, ^dto/UserResponse.java^, ^service/UserService.java^, ^controller/UserController.java^, ^exception/UsernameTakenException.java^. **Changed:** ^pom.xml^, ^GlobalExceptionHandler.java^, ^application.yml^.

### Step 1: Add the dependency

~~~xml pom.xml
<!-- add inside <dependencies> -->
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-test</artifactId>
    <scope>test</scope>
</dependency>
~~~

Restart and observe the defaults:

~~~powershell
curl.exe -i http://localhost:8080/api/books
# HTTP/1.1 401
# WWW-Authenticate: Basic realm="Realm"

curl.exe -i -u user:PASTE_GENERATED_PASSWORD http://localhost:8080/api/books
# HTTP/1.1 200  [ ...books... ]
~~~

On Windows PowerShell use ^curl.exe^ explicitly, because plain ^curl^ is an alias for ^Invoke-WebRequest^ with different flags.

### Step 2: First demo with in-memory users

Before touching the database, prove the configuration works with two hard-coded users. This is a learning step only; never ship in-memory users.

~~~java src/main/java/com/example/bookstore/security/SecurityConfig.java
package com.example.bookstore.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;

// TEMPORARY version for the first demo; replaced in Step 6.
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable()) // stateless API, see section 1.10
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.GET, "/api/books", "/api/books/**").permitAll()
                .requestMatchers("/actuator/health").permitAll()
                .anyRequest().authenticated())
            .httpBasic(Customizer.withDefaults());
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    UserDetailsService userDetailsService(PasswordEncoder encoder) {
        var julian = User.withUsername("julian")
                .password(encoder.encode("password123"))
                .roles("USER")
                .build();
        var admin = User.withUsername("admin")
                .password(encoder.encode("admin123"))
                .roles("ADMIN", "USER")
                .build();
        return new InMemoryUserDetailsManager(julian, admin);
    }
}
~~~

What Spring does with this: the ^SecurityFilterChain^ bean replaces Boot's default chain. Boot sees your ^UserDetailsService^ and ^PasswordEncoder^ beans and automatically builds a ^DaoAuthenticationProvider^ inside a ^ProviderManager^ from them; you never wire the manager yourself. ^.roles("USER")^ is shorthand that stores the authority ^ROLE_USER^.

~~~powershell
curl.exe -i http://localhost:8080/api/books                       # 200, public read
curl.exe -i -X DELETE http://localhost:8080/api/books/1           # 401, no credentials
curl.exe -i -u julian:wrong -X DELETE http://localhost:8080/api/books/1   # 401
curl.exe -i -u julian:password123 -X DELETE http://localhost:8080/api/books/1  # 204
~~~

It works, but users live in code. Let's move them to the database.

### Step 3: The user entity and role

~~~java src/main/java/com/example/bookstore/model/Role.java
package com.example.bookstore.model;

public enum Role {
    USER,
    ADMIN;

    /** Spring's hasRole('ADMIN') checks for the authority string "ROLE_ADMIN". */
    public String authority() {
        return "ROLE_" + name();
    }
}
~~~

~~~java src/main/java/com/example/bookstore/model/AppUser.java
package com.example.bookstore.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.Instant;

@Entity
@Table(name = "app_users") // "user" is a reserved word in PostgreSQL and H2
public class AppUser {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 50)
    private String username;

    @Column(nullable = false, unique = true, length = 120)
    private String email;

    @Column(name = "password_hash", nullable = false, length = 100)
    private String passwordHash;

    @Enumerated(EnumType.STRING) // store "ADMIN", never the ordinal 1
    @Column(nullable = false, length = 20)
    private Role role = Role.USER;

    @Column(nullable = false)
    private boolean enabled = true;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt = Instant.now();

    protected AppUser() {
        // required by JPA
    }

    public AppUser(String username, String email, String passwordHash, Role role) {
        this.username = username;
        this.email = email;
        this.passwordHash = passwordHash;
        this.role = role;
    }

    public Long getId() { return id; }
    public String getUsername() { return username; }
    public String getEmail() { return email; }
    public String getPasswordHash() { return passwordHash; }
    public Role getRole() { return role; }
    public boolean isEnabled() { return enabled; }
    public Instant getCreatedAt() { return createdAt; }

    public void setRole(Role role) { this.role = role; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public void changePasswordHash(String newHash) { this.passwordHash = newHash; }
}
~~~

Design choices: the entity does **not** implement ^UserDetails^. Mixing persistence and security concerns in one class works, but it leaks Spring Security types into the domain and makes the entity awkward to serialize. The column is named ^password_hash^ so nobody is ever tempted to store a raw password in it. One role per user keeps the course simple; a ^@ElementCollection Set<Role>^ is the natural extension.

### Step 4: Repository

~~~java src/main/java/com/example/bookstore/repository/UserRepository.java
package com.example.bookstore.repository;

import com.example.bookstore.model.AppUser;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface UserRepository extends JpaRepository<AppUser, Long> {

    Optional<AppUser> findByUsername(String username);

    boolean existsByUsername(String username);

    boolean existsByEmail(String email);
}
~~~

### Step 5: The custom UserDetailsService (the adapter)

~~~java src/main/java/com/example/bookstore/security/AppUserDetailsService.java
package com.example.bookstore.security;

import com.example.bookstore.repository.UserRepository;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AppUserDetailsService implements UserDetailsService {

    private final UserRepository userRepository;

    public AppUserDetailsService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    @Transactional(readOnly = true)
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        return userRepository.findByUsername(username)
                .map(user -> User.withUsername(user.getUsername())
                        .password(user.getPasswordHash())
                        .authorities(user.getRole().authority())
                        .disabled(!user.isEnabled())
                        .build())
                .orElseThrow(() -> new UsernameNotFoundException("User not found: " + username));
    }
}
~~~

**Under the hood:** ^DaoAuthenticationProvider^ converts ^UsernameNotFoundException^ into a generic ^BadCredentialsException^ ("Bad credentials") so an attacker cannot tell "unknown user" from "wrong password" (user enumeration). It even runs a dummy BCrypt check for unknown users so the response time is the same. Your message never reaches the client.

### Step 6: Final SecurityConfig with CORS and JSON error handlers

Delete the in-memory ^UserDetailsService^ bean; ^AppUserDetailsService^ is now the only one, so Boot uses it automatically.

~~~java src/main/java/com/example/bookstore/security/SecurityConfig.java
package com.example.bookstore.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.time.Duration;
import java.util.List;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    private final ProblemDetailAuthenticationEntryPoint authenticationEntryPoint;
    private final ProblemDetailAccessDeniedHandler accessDeniedHandler;

    public SecurityConfig(ProblemDetailAuthenticationEntryPoint authenticationEntryPoint,
                          ProblemDetailAccessDeniedHandler accessDeniedHandler) {
        this.authenticationEntryPoint = authenticationEntryPoint;
        this.accessDeniedHandler = accessDeniedHandler;
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            // Stateless API: credentials travel in the Authorization header, never in cookies.
            .csrf(csrf -> csrf.disable())
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()          // CORS preflight
                .requestMatchers(HttpMethod.POST, "/api/users/register").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/books", "/api/books/**").permitAll()
                .requestMatchers("/actuator/health", "/error").permitAll()
                .anyRequest().authenticated())
            .httpBasic(basic -> basic.authenticationEntryPoint(authenticationEntryPoint))
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(authenticationEntryPoint)
                .accessDeniedHandler(accessDeniedHandler));
        return http.build();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(); // strength 10; raise to 12 if your hardware allows ~100ms
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("http://localhost:5173")); // your frontend, never "*" with credentials
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
        config.setMaxAge(Duration.ofHours(1));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
~~~

Why ^/error^ is permitted: when a controller throws, Boot forwards to ^/error^ internally; if that path is protected, a 404 or 500 can turn into a misleading 401.

### Step 7: ProblemDetail JSON for 401 and 403

~~~java src/main/java/com/example/bookstore/security/ProblemDetailAuthenticationEntryPoint.java
package com.example.bookstore.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.time.Instant;

@Component
public class ProblemDetailAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private final ObjectMapper objectMapper;

    public ProblemDetailAuthenticationEntryPoint(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void commence(HttpServletRequest request,
                         HttpServletResponse response,
                         AuthenticationException authException) throws IOException {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.UNAUTHORIZED,
                "Authentication is required to access this resource.");
        problem.setTitle("Unauthorized");
        problem.setType(URI.create("https://bookstore.example.com/problems/unauthorized"));
        problem.setInstance(URI.create(request.getRequestURI()));
        problem.setProperty("timestamp", Instant.now());

        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        // Deliberately NO "WWW-Authenticate: Basic" header: it would make browsers
        // pop up a native login dialog, which is wrong for a JSON API.
        objectMapper.writeValue(response.getOutputStream(), problem);
    }
}
~~~

~~~java src/main/java/com/example/bookstore/security/ProblemDetailAccessDeniedHandler.java
package com.example.bookstore.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URI;
import java.time.Instant;

@Component
public class ProblemDetailAccessDeniedHandler implements AccessDeniedHandler {

    private final ObjectMapper objectMapper;

    public ProblemDetailAccessDeniedHandler(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void handle(HttpServletRequest request,
                       HttpServletResponse response,
                       AccessDeniedException accessDeniedException) throws IOException {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.FORBIDDEN,
                "You do not have permission to perform this action.");
        problem.setTitle("Forbidden");
        problem.setType(URI.create("https://bookstore.example.com/problems/forbidden"));
        problem.setInstance(URI.create(request.getRequestURI()));
        problem.setProperty("timestamp", Instant.now());

        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(), problem);
    }
}
~~~

We inject Boot's auto-configured ^ObjectMapper^ (instead of ^new ObjectMapper()^) so ^Instant^ is serialized correctly with the JavaTimeModule and the same settings as the rest of the API.

### Step 8: Registering users with encoded passwords

~~~java src/main/java/com/example/bookstore/dto/RegisterRequest.java
package com.example.bookstore.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record RegisterRequest(
        @NotBlank @Size(min = 3, max = 50)
        @Pattern(regexp = "[a-zA-Z0-9._-]+", message = "may contain letters, digits, dot, underscore and dash")
        String username,

        @NotBlank @Email @Size(max = 120)
        String email,

        @NotBlank @Size(min = 8, max = 72, message = "must be between 8 and 72 characters")
        String password
) {
    // BCrypt only uses the first 72 bytes of a password, hence the max.
    @Override
    public String toString() {
        return "RegisterRequest[username=" + username + ", email=" + email + ", password=****]";
    }
}
~~~

Overriding ^toString^ matters: records print all fields by default, and one careless ^log.info("{}", request)^ would write passwords into your log aggregator.

~~~java src/main/java/com/example/bookstore/dto/UserResponse.java
package com.example.bookstore.dto;

import com.example.bookstore.model.AppUser;

import java.time.Instant;

public record UserResponse(Long id, String username, String email, String role, Instant createdAt) {

    public static UserResponse from(AppUser user) {
        return new UserResponse(user.getId(), user.getUsername(), user.getEmail(),
                user.getRole().name(), user.getCreatedAt());
    }
}
~~~

~~~java src/main/java/com/example/bookstore/exception/UsernameTakenException.java
package com.example.bookstore.exception;

public class UsernameTakenException extends RuntimeException {
    public UsernameTakenException(String message) {
        super(message);
    }
}
~~~

~~~java src/main/java/com/example/bookstore/service/UserService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.RegisterRequest;
import com.example.bookstore.dto.UserResponse;
import com.example.bookstore.exception.UsernameTakenException;
import com.example.bookstore.model.AppUser;
import com.example.bookstore.model.Role;
import com.example.bookstore.repository.UserRepository;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public UserService(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Transactional
    public UserResponse register(RegisterRequest request) {
        if (userRepository.existsByUsername(request.username())) {
            throw new UsernameTakenException("Username '" + request.username() + "' is already taken");
        }
        if (userRepository.existsByEmail(request.email())) {
            throw new UsernameTakenException("Email is already registered");
        }
        String hash = passwordEncoder.encode(request.password()); // the ONLY place a raw password is touched
        AppUser saved = userRepository.save(
                new AppUser(request.username(), request.email(), hash, Role.USER));
        return UserResponse.from(saved);
    }
}
~~~

Note that registration always assigns ^Role.USER^. Letting the client send ^"role":"ADMIN"^ in the request body is a real-world privilege escalation bug called **mass assignment**. The unique constraints on the table are the final safety net against two simultaneous registrations racing past the ^exists^ check.

~~~java src/main/java/com/example/bookstore/controller/UserController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.RegisterRequest;
import com.example.bookstore.dto.UserResponse;
import com.example.bookstore.service.UserService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public UserResponse register(@Valid @RequestBody RegisterRequest request) {
        return userService.register(request);
    }

    /** Spring MVC injects the current Authentication from the SecurityContextHolder. */
    @GetMapping("/me")
    public Map<String, Object> me(Authentication authentication) {
        List<String> authorities = authentication.getAuthorities().stream()
                .map(a -> a.getAuthority())
                .toList();
        return Map.of("username", authentication.getName(), "authorities", authorities);
    }
}
~~~

Add one handler to the existing ^GlobalExceptionHandler^ from Lesson 2.3 (only the new method is shown; keep the existing ones):

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
// ... existing imports, plus:
// import org.springframework.http.HttpStatus;
// import org.springframework.http.ProblemDetail;

    @ExceptionHandler(UsernameTakenException.class)
    public ProblemDetail handleUsernameTaken(UsernameTakenException ex) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.CONFLICT, ex.getMessage());
        problem.setTitle("Conflict");
        return problem;
    }
~~~

### Step 9: Seed an admin safely

Never put a real admin password in a SQL script in git. A small ^CommandLineRunner^ reading an environment variable works well for development:

~~~java src/main/java/com/example/bookstore/config/AdminSeeder.java
package com.example.bookstore.config;

import com.example.bookstore.model.AppUser;
import com.example.bookstore.model.Role;
import com.example.bookstore.repository.UserRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

@Component
public class AdminSeeder implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminSeeder.class);

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final String adminPassword;

    public AdminSeeder(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       @Value("§{bookstore.admin.password:}") String adminPassword) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.adminPassword = adminPassword;
    }

    @Override
    public void run(String... args) {
        if (adminPassword.isBlank() || userRepository.existsByUsername("admin")) {
            return;
        }
        userRepository.save(new AppUser("admin", "admin@bookstore.example.com",
                passwordEncoder.encode(adminPassword), Role.ADMIN));
        log.info("Seeded initial admin user");
    }
}
~~~

~~~yaml src/main/resources/application.yml
# add to the existing file
bookstore:
  admin:
    password: §{ADMIN_PASSWORD:}

logging:
  level:
    org.springframework.security: INFO   # switch to TRACE when debugging 401s
~~~

### Step 10: Run and test with curl

~~~powershell
$env:ADMIN_PASSWORD = "Adm1n-Secret!"
./mvnw spring-boot:run
~~~

~~~powershell
# 1. Register (public)
curl.exe -i -X POST http://localhost:8080/api/users/register -H "Content-Type: application/json" -d '{\"username\":\"julian\",\"email\":\"julian@example.com\",\"password\":\"password123\"}'
# HTTP/1.1 201
# {"id":2,"username":"julian","email":"julian@example.com","role":"USER","createdAt":"2026-11-20T..."}

# 2. Register again -> 409 Conflict (ProblemDetail)

# 3. Public read works without credentials
curl.exe -i http://localhost:8080/api/books

# 4. Protected endpoint without credentials -> 401 ProblemDetail
curl.exe -i http://localhost:8080/api/users/me
~~~

~~~json
{
  "type": "https://bookstore.example.com/problems/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Authentication is required to access this resource.",
  "instance": "/api/users/me",
  "timestamp": "2026-11-20T20:15:03.512Z"
}
~~~

~~~powershell
# 5. With Basic credentials (curl builds the Authorization header for you)
curl.exe -i -u julian:password123 http://localhost:8080/api/users/me
# {"username":"julian","authorities":["ROLE_USER"]}

# 6. Create a book as julian -> 201 (any authenticated user may write, for now)
curl.exe -i -u julian:password123 -X POST http://localhost:8080/api/books -H "Content-Type: application/json" -d '{\"title\":\"Clean Code\",\"isbn\":\"9780132350884\",\"price\":39.90,\"publishedYear\":2008}'

# 7. See what -u actually sends (base64 is NOT encryption)
curl.exe -v -u julian:password123 http://localhost:8080/api/users/me 2>&1 | Select-String Authorization
# > Authorization: Basic anVsaWFuOnBhc3N3b3JkMTIz
~~~

Open the H2 console or psql and run ^SELECT username, password_hash FROM app_users;^. You will see 60-character BCrypt hashes, and registering two users with the same password produces two different hashes thanks to the salt.

In bash or Git Bash the JSON body is simpler: ^-d '{"username":"julian",...}'^ without the backslashes. The escaping above is for Windows PowerShell 5 passing quotes to ^curl.exe^.

---

## 3. Common Pitfalls & Best Practices

- **Copying WebSecurityConfigurerAdapter tutorials.** It no longer exists in Spring Security 6. Fix: declare a ^SecurityFilterChain^ bean and use the lambda DSL; ignore any guide that still uses ^.and()^.
- **Disabling CSRF without understanding why.** Turning it off in a cookie-session app opens a real attack. Fix: disable CSRF only when the API is stateless and credentials travel in the Authorization header; keep it on for anything relying on cookies.
- **Wrong order of requestMatchers.** Putting ^anyRequest().authenticated()^ or a broad pattern first shadows later rules, because first match wins. Fix: most specific rules first, ^anyRequest()^ last, deny by default.
- **Storing plain text or fast-hashed passwords.** MD5 or SHA-256 are cracked at billions of guesses per second. Fix: always ^passwordEncoder.encode()^ with BCrypt (or Argon2), and never log or return the hash.
- **Expecting @RestControllerAdvice to handle 401/403.** Security exceptions are thrown in filters before the DispatcherServlet. Fix: implement ^AuthenticationEntryPoint^ and ^AccessDeniedHandler^ and register them in ^exceptionHandling^.
- **Mass assignment of roles.** Accepting a role field in the registration DTO lets anyone become admin. Fix: the server decides the role; promotion is a separate admin-only operation.
- **CORS configured only in WebMvcConfigurer.** The preflight hits Spring Security first and gets a 401. Fix: enable ^http.cors(...)^ with a ^CorsConfigurationSource^, and never combine wildcard origins with credentials.
- **Using HTTP Basic over plain HTTP in production.** Base64 credentials are readable by anyone on the path. Fix: TLS everywhere, and prefer tokens (Lesson 4.2) for public APIs.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Secure the Bookstore with database users","tasks":["Add ^spring-boot-starter-security^, start the app, and record which endpoints now return 401 and the generated password line in the log.","Create ^AppUser^, ^Role^, ^UserRepository^ and ^AppUserDetailsService^ exactly as in the lesson, then remove any in-memory users.","Register two users with the SAME password via ^POST /api/users/register^ and verify in the database that their ^password_hash^ values differ. Explain why in one sentence.","Call ^GET /api/users/me^ with ^curl.exe -u^ using a correct and a wrong password, and confirm the wrong one returns a ProblemDetail JSON body with status 401.","Enable ^logging.level.org.springframework.security=TRACE^ and list the filters you see executed for one request."]},
{"title":"Exercise 2 (Challenge): Hardening and error handling","tasks":["Write a ^@WebMvcTest^ or ^@SpringBootTest^ using ^spring-security-test^ (look up ^httpBasic()^ and ^@WithMockUser^ in the docs) proving that DELETE on a book without credentials returns 401.","Add a ^PUT /api/users/me/password^ endpoint that requires the current password and a new one, verifies the old one with ^passwordEncoder.matches^, and stores the new hash.","Make login fail for disabled users: set ^enabled=false^ for a user in the database and confirm which status and exception occur, then map it to a clear ProblemDetail detail message.","Configure CORS so that only ^http://localhost:5173^ is allowed and verify a preflight with ^curl.exe -i -X OPTIONS^ plus the ^Origin^ and ^Access-Control-Request-Method^ headers."]},
{"title":"Exercise 3 (Thinking): Reasoning about the architecture","tasks":["In your own words, describe the path of one request from Tomcat through ^DelegatingFilterProxy^, ^FilterChainProxy^ and ^SecurityFilterChain^ to your controller. Why are three layers needed?","Explain why ^DaoAuthenticationProvider^ hides the difference between an unknown username and a wrong password, and what attack that prevents.","A colleague's server-rendered app uses session cookies and disabled CSRF \"because forms stopped working\". Explain the risk with a concrete attack scenario.","Read the Spring Security reference section on the ^DelegatingPasswordEncoder^ and describe how you would migrate a legacy database of SHA-1 hashes to BCrypt without forcing a password reset."]}
]
};
