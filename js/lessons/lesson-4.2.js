LESSONS['4.2']={
md:String.raw`## 1. Concept & Theory

> **Where the project stands:** after Lesson 4.1 the Bookstore API has ^AppUser^ entities with BCrypt hashes, a custom ^AppUserDetailsService^, a stateless ^SecurityFilterChain^, CORS, and ProblemDetail JSON for 401 and 403. Clients authenticate with HTTP Basic, which means sending the raw password on **every** request and running BCrypt on every call. In this lesson we replace Basic with **JWT bearer tokens**, add a login endpoint, and introduce **role-based access control**: everyone may read books, logged-in users may review, and only admins may create, change or delete books.

### 1.1 Sessions vs tokens

There are two big families of "remembering who someone is" after login:

| Aspect | Server session (JSESSIONID cookie) | Self-contained token (JWT) |
|---|---|---|
| Where state lives | Server memory or Redis | Inside the token, signed by the server |
| What the client holds | Random session id | Signed claims (user, roles, expiry) |
| Horizontal scaling | Needs sticky sessions or shared store | Any instance can verify with the key |
| Revocation | Easy: delete the session | Hard: valid until expiry (needs denylist or short TTL) |
| CSRF exposure | Yes (cookie sent automatically) | No, if sent in the Authorization header |
| Typical clients | Server-rendered web apps | SPAs, mobile apps, service-to-service |

**Analogy:** a session is a coat-check ticket: the number is meaningless, the cloakroom (server) must look it up. A JWT is a festival wristband: the guard checks the holographic seal (signature) and the date printed on it, without calling the box office. Fast and scalable, but you cannot "take back" a wristband before the festival ends; you can only make wristbands that expire quickly.

Neither is "better". Sessions are an excellent default for classic web apps. Tokens shine when you have many API instances, mobile clients, or multiple services that must trust the same identity.

### 1.2 JWT structure: header.payload.signature

A JSON Web Token (RFC 7519) is three Base64URL-encoded parts separated by dots:

~~~text
eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqdWxpYW4iLCJyb2xlcyI6WyJST0xFX1VTRVIiXSwiaWF0IjoxNzY0MDAwMDAwLCJleHAiOjE3NjQwMDA5MDB9.4Xh2...signature
|------ header ------|.|--------------------------- payload (claims) ---------------------------------------------|.|-- signature --|
~~~

~~~json
{ "alg": "HS256", "typ": "JWT" }
~~~

~~~json
{
  "iss": "bookstore-api",
  "sub": "julian",
  "roles": ["ROLE_USER"],
  "iat": 1764000000,
  "exp": 1764000900
}
~~~

- **Header**: algorithm and type.
- **Payload**: claims. Registered ones: ^sub^ (subject), ^iss^ (issuer), ^exp^ (expiry, seconds since epoch), ^iat^ (issued at), ^jti^ (unique id). Plus your own, e.g. ^roles^.
- **Signature**: ^HMACSHA256(base64url(header) + "." + base64url(payload), secret)^.

**Critical:** the payload is **encoded, not encrypted**. Paste any token into jwt.io and you read it. The signature only guarantees **integrity** (nobody changed it) and **authenticity** (it was issued by someone holding the key). Never put passwords, emails you would not publish, or personal data in it.

### 1.3 Signing with HS256 and where the secret comes from

**HS256** (HMAC with SHA-256) uses one symmetric secret both to sign and to verify. It is simple and perfect when the same application issues and validates tokens. **RS256 / ES256** use a private key to sign and a public key to verify; use them when other services must verify tokens without being able to mint them (that is how Keycloak, Auth0, Cognito work).

For HS256 the secret must be at least **256 bits (32 bytes)** of randomness; jjwt refuses shorter keys with a ^WeakKeyException^. Anyone with the secret can mint an admin token, so it is as sensitive as a database root password:

- It comes from an environment variable: ^§{JWT_SECRET}^ in ^application.yml^.
- It is **never** committed to git. A secret in git history is compromised forever, even after you delete the line, and bots scan public GitHub for secrets within minutes.
- In production it lives in a secret manager (AWS Secrets Manager, Vault, Kubernetes Secret) and is injected as an env var.
- Rotating it logs everyone out (all existing tokens fail verification), which is also your emergency "revoke all" button.

Generate one in PowerShell:

~~~powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
~~~

### 1.4 Access tokens vs refresh tokens

| | Access token | Refresh token |
|---|---|---|
| Purpose | Call the API | Obtain a new access token |
| Lifetime | Short: 5-15 minutes | Long: days or weeks |
| Sent to | Every API request | Only the refresh endpoint |
| Format | Usually JWT (stateless) | Usually opaque random string stored in DB |
| Revocable | Not really (short TTL instead) | Yes, delete or flag the DB row |

The combination gives you the best of both worlds: the hot path (every request) is stateless and fast, while the long-lived credential is stored server-side and can be revoked when a user logs out or a device is stolen. **Refresh token rotation** (issue a new refresh token on every use and invalidate the old one) lets you detect theft: if an old refresh token is ever presented again, someone copied it, and you revoke the whole family.

In this lesson we fully implement the access token and sketch the refresh flow in section 2.10.

### 1.5 How JWT authentication plugs into the filter chain

Spring has no built-in "JWT filter" in the core web module, so we write one. It extends **OncePerRequestFilter**, which guarantees one execution per request even when the request is forwarded internally (e.g. to ^/error^).

~~~text
Request: Authorization: Bearer eyJ...
  -> CorsFilter
  -> JwtAuthenticationFilter (ours, placed BEFORE UsernamePasswordAuthenticationFilter)
        no header?             -> continue unauthenticated (public endpoints still work)
        parse + verify token   -> invalid or expired? continue unauthenticated
        valid                  -> build UsernamePasswordAuthenticationToken(principal, null, authorities)
                                  SecurityContextHolder.getContext().setAuthentication(...)
  -> AnonymousAuthenticationFilter (only if nothing was set)
  -> ExceptionTranslationFilter
  -> AuthorizationFilter: checks rules -> 401 (anonymous) / 403 (wrong role) / pass
  -> DispatcherServlet -> controller (@PreAuthorize checked here by an AOP proxy)
~~~

Why "before ^UsernamePasswordAuthenticationFilter^"? It is a stable anchor in the ordered chain that sits before ^AnonymousAuthenticationFilter^ and ^AuthorizationFilter^, so by the time authorization runs, the context already contains our user.

Why does the filter not throw on an invalid token? Because the filter does not know whether the endpoint is public. It simply refuses to authenticate; if the endpoint needs authentication, ^AuthorizationFilter^ denies and our ^ProblemDetailAuthenticationEntryPoint^ returns 401. One place produces 401s, consistently.

**SessionCreationPolicy.STATELESS** tells Spring Security never to create an ^HttpSession^ and never to read the security context from one. Each request must prove itself again with its token.

### 1.6 Roles, authorities and RBAC

**Role-Based Access Control** assigns permissions to roles and roles to users. In Spring, a role is just an authority with the ^ROLE_^ prefix:

| You write | Spring checks for authority | Notes |
|---|---|---|
| hasRole('ADMIN') | ROLE_ADMIN | Prefix added automatically; do not write ROLE_ yourself here |
| hasAuthority('ROLE_ADMIN') | ROLE_ADMIN | Exact string match |
| hasAnyRole('USER','ADMIN') | ROLE_USER or ROLE_ADMIN | |
| hasAuthority('book:delete') | book:delete | Fine-grained permissions, no prefix |

Our Bookstore rules:

| Method + path | Who |
|---|---|
| POST /api/auth/register, POST /api/auth/login | Everyone |
| GET /api/books/** , GET /api/authors/** , GET /api/categories/** | Everyone |
| POST, PUT, DELETE /api/books/** | ADMIN |
| GET /api/users/me | Any authenticated user |
| /api/admin/** | ADMIN |
| /actuator/health | Everyone |
| anything else | Authenticated (deny by default) |

### 1.7 URL rules vs method security

There are two layers to express authorization, and production systems usually use both:

- **URL-based** (^authorizeHttpRequests^): coarse, central, easy to audit, evaluated in the filter chain before any controller code runs.
- **Method-based** (^@EnableMethodSecurity^ + ^@PreAuthorize^): fine-grained, next to the business logic, can use method arguments, e.g. ^@PreAuthorize("#username == authentication.name")^. It works through a Spring AOP proxy, exactly like ^@Transactional^ from Lesson 3.3, so it has the same limitation: calling an annotated method from **within the same class** bypasses the proxy and the check.

When ^@PreAuthorize^ fails it throws ^AccessDeniedException^ from inside the ^DispatcherServlet^. Spring Security's ^ExceptionTranslationFilter^ still sees it as the exception propagates back up and calls our ^AccessDeniedHandler^ (403), as long as your ^@RestControllerAdvice^ does not swallow it with a catch-all ^Exception^ handler. We will guard against that.

### 1.8 Security pitfalls specific to JWT

- **Algorithm confusion / "alg: none".** Early libraries trusted the ^alg^ header: an attacker set it to ^none^ and removed the signature, or switched RS256 to HS256 and signed with the public key. Defense: the server decides the algorithm and key. jjwt 0.12 rejects unsigned tokens in ^parseSignedClaims^ and ^verifyWith(SecretKey)^ pins HMAC verification.
- **Long-lived access tokens.** A stolen 30-day token is a 30-day breach with no way to revoke. Keep access tokens at 15 minutes or less and use refresh tokens.
- **localStorage tradeoffs.** Storing a JWT in ^localStorage^ is simple and immune to CSRF, but any XSS bug can read and exfiltrate it. An ^HttpOnly; Secure; SameSite^ cookie cannot be read by JavaScript, but reintroduces CSRF (keep CSRF protection on then). Many teams use the "backend for frontend" pattern: the browser holds only a session cookie, the BFF holds tokens. There is no free lunch; know which risk you accept.
- **Sensitive data in the payload.** Anyone can decode it. Put only an id, roles and expiry.
- **Trusting claims without verifying.** Decoding without verifying the signature is the same as no security at all.
- **Not validating expiry and issuer.** jjwt checks ^exp^ automatically; also require your ^iss^ so a token from another system signed with a reused secret is rejected.

### 1.9 The production alternative: oauth2-resource-server

Writing your own JWT filter is the best way to **understand** token authentication, and it is reasonable for a single self-contained service. For production systems Spring offers ^spring-boot-starter-oauth2-resource-server^: configure ^http.oauth2ResourceServer(o -> o.jwt(...))^ plus an issuer URI or a key, and Spring provides a battle-tested ^BearerTokenAuthenticationFilter^, ^JwtDecoder^ with key rotation via JWKS, standard ^WWW-Authenticate^ error responses, and claim-to-authority mapping. Combined with an identity provider (Keycloak, Okta, Cognito, Entra ID) you stop handling passwords at all. Learn the mechanics here, then prefer the standard pieces at work.

---

## 2. Code Walkthrough

**New files:** ^security/JwtProperties.java^, ^security/JwtService.java^, ^security/JwtAuthenticationFilter.java^, ^dto/LoginRequest.java^, ^dto/TokenResponse.java^, ^service/AuthService.java^, ^controller/AuthController.java^, ^controller/AdminController.java^. **Changed:** ^pom.xml^, ^application.yml^, ^BookstoreApplication.java^, ^security/SecurityConfig.java^, ^controller/BookController.java^ (annotations), ^controller/UserController.java^, ^exception/GlobalExceptionHandler.java^. ^UserController.register^ moves to ^AuthController^.

### Step 1: Dependencies

~~~xml pom.xml
<!-- add inside <dependencies> -->
<dependency>
    <groupId>io.jsonwebtoken</groupId>
    <artifactId>jjwt-api</artifactId>
    <version>0.12.6</version>
</dependency>
<dependency>
    <groupId>io.jsonwebtoken</groupId>
    <artifactId>jjwt-impl</artifactId>
    <version>0.12.6</version>
    <scope>runtime</scope>
</dependency>
<dependency>
    <groupId>io.jsonwebtoken</groupId>
    <artifactId>jjwt-jackson</artifactId>
    <version>0.12.6</version>
    <scope>runtime</scope>
</dependency>
~~~

Only ^jjwt-api^ is on the compile classpath; the implementation and JSON binding are runtime-only. That prevents you from accidentally coding against internal classes that change between versions.

### Step 2: Configuration with the secret from the environment

~~~yaml src/main/resources/application.yml
# add to the existing file
bookstore:
  jwt:
    secret: §{JWT_SECRET}          # Base64, at least 32 bytes. NO default on purpose: fail fast if missing.
    issuer: bookstore-api
    access-token-ttl: 15m
~~~

Add ^.env^ and any local secrets file to ^.gitignore^. Because there is no default value, the app refuses to start without ^JWT_SECRET^, which is far better than silently using a well-known dev secret in production.

~~~java src/main/java/com/example/bookstore/security/JwtProperties.java
package com.example.bookstore.security;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

@Validated
@ConfigurationProperties(prefix = "bookstore.jwt")
public record JwtProperties(
        @NotBlank String secret,
        @NotBlank String issuer,
        @NotNull Duration accessTokenTtl
) {
}
~~~

~~~java src/main/java/com/example/bookstore/BookstoreApplication.java
package com.example.bookstore;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class BookstoreApplication {

    public static void main(String[] args) {
        SpringApplication.run(BookstoreApplication.class, args);
    }
}
~~~

Boot binds ^access-token-ttl: 15m^ to a ^Duration^ automatically (relaxed binding plus its duration converter).

### Step 3: JwtService with the jjwt 0.12 API

~~~java src/main/java/com/example/bookstore/security/JwtService.java
package com.example.bookstore.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.UUID;

@Service
public class JwtService {

    private final SecretKey key;
    private final JwtProperties properties;

    public JwtService(JwtProperties properties) {
        this.properties = properties;
        // Throws WeakKeyException at startup if the secret is shorter than 256 bits.
        this.key = Keys.hmacShaKeyFor(Decoders.BASE64.decode(properties.secret()));
    }

    public String generateAccessToken(UserDetails user) {
        Instant now = Instant.now();
        List<String> roles = user.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .toList();
        return Jwts.builder()
                .id(UUID.randomUUID().toString())
                .issuer(properties.issuer())
                .subject(user.getUsername())
                .claim("roles", roles)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(properties.accessTokenTtl())))
                .signWith(key) // algorithm inferred from the key: HS256 for a 256-bit key
                .compact();
    }

    /**
     * Verifies signature, expiry and issuer. Throws JwtException
     * (ExpiredJwtException, SignatureException, MalformedJwtException, ...) when invalid.
     */
    public Claims parseAndValidate(String token) throws JwtException {
        return Jwts.parser()
                .verifyWith(key)
                .requireIssuer(properties.issuer())
                .clockSkewSeconds(30)
                .build()
                .parseSignedClaims(token)
                .getPayload();
    }

    public long accessTokenTtlSeconds() {
        return properties.accessTokenTtl().toSeconds();
    }
}
~~~

^javax.crypto.SecretKey^ is part of the JDK, not the old Java EE namespace, so this ^javax^ import is correct; the "jakarta only" rule applies to servlet, persistence and validation APIs.

Note what we did **not** do: no ^Jwts.parser().setSigningKey(...)^ or ^parseClaimsJws^ (deprecated in 0.12), and no reading of the ^alg^ header to decide how to verify.

### Step 4: The JWT filter

~~~java src/main/java/com/example/bookstore/security/JwtAuthenticationFilter.java
package com.example.bookstore.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(JwtAuthenticationFilter.class);
    private static final String BEARER_PREFIX = "Bearer ";

    private final JwtService jwtService;

    public JwtAuthenticationFilter(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String header = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (header == null || !header.startsWith(BEARER_PREFIX)) {
            filterChain.doFilter(request, response); // anonymous; authorization decides later
            return;
        }

        String token = header.substring(BEARER_PREFIX.length());
        try {
            Claims claims = jwtService.parseAndValidate(token);
            List<SimpleGrantedAuthority> authorities = extractRoles(claims).stream()
                    .map(SimpleGrantedAuthority::new)
                    .toList();
            // Principal built from the token alone: no database hit per request.
            User principal = new User(claims.getSubject(), "", authorities);

            var authentication = new UsernamePasswordAuthenticationToken(principal, null, authorities);
            authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));

            SecurityContext context = SecurityContextHolder.createEmptyContext();
            context.setAuthentication(authentication);
            SecurityContextHolder.setContext(context);
        } catch (ExpiredJwtException ex) {
            log.debug("Expired JWT for subject {}", ex.getClaims().getSubject());
            request.setAttribute("jwt_error", "Access token has expired");
        } catch (JwtException | IllegalArgumentException ex) {
            log.debug("Invalid JWT: {}", ex.getMessage());
            request.setAttribute("jwt_error", "Access token is invalid");
        }
        filterChain.doFilter(request, response);
    }

    private List<String> extractRoles(Claims claims) {
        Object raw = claims.get("roles");
        if (raw instanceof List<?> list) {
            return list.stream().map(String::valueOf).toList();
        }
        return List.of();
    }
}
~~~

Design decisions worth discussing in a code review:

- **No DB lookup per request.** The roles come from the signed token. That is the whole point of stateless auth, but it means a role change or a disabled account only takes effect when the token expires. With a 15-minute TTL that is usually acceptable; if not, load the user via ^UserDetailsService^ here and accept the DB cost.
- **Never log the token itself.** It is a bearer credential: whoever has it is the user.
- **The ^jwt_error^ attribute** lets the entry point explain why authentication failed (next step), without the filter writing responses itself.

**Important Boot detail:** because the filter is a ^@Component^ and a ^Filter^, Spring Boot would also register it **a second time** directly in Tomcat's chain, outside Spring Security. We disable that registration in ^SecurityConfig^ with a ^FilterRegistrationBean^.

### Step 5: Tell the client the token expired

Replace the ^commence^ method body of the entry point from 4.1 so the detail reflects the reason:

~~~java src/main/java/com/example/bookstore/security/ProblemDetailAuthenticationEntryPoint.java
package com.example.bookstore.security;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
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
        Object jwtError = request.getAttribute("jwt_error");
        String detail = jwtError != null
                ? jwtError.toString()
                : "Authentication is required to access this resource.";

        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.UNAUTHORIZED, detail);
        problem.setTitle("Unauthorized");
        problem.setType(URI.create("https://bookstore.example.com/problems/unauthorized"));
        problem.setInstance(URI.create(request.getRequestURI()));
        problem.setProperty("timestamp", Instant.now());

        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setHeader(HttpHeaders.WWW_AUTHENTICATE, "Bearer");
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        objectMapper.writeValue(response.getOutputStream(), problem);
    }
}
~~~

A well-behaved client reacts to 401 with "Access token has expired" by calling the refresh endpoint and retrying once; any other 401 sends the user to the login screen. ^ProblemDetailAccessDeniedHandler^ from 4.1 is unchanged.

### Step 6: The new SecurityConfig

~~~java src/main/java/com/example/bookstore/security/SecurityConfig.java
package com.example.bookstore.security;

import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.config.annotation.authentication.configuration.AuthenticationConfiguration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.time.Duration;
import java.util.List;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity // enables @PreAuthorize / @PostAuthorize
public class SecurityConfig {

    private final JwtAuthenticationFilter jwtAuthenticationFilter;
    private final ProblemDetailAuthenticationEntryPoint authenticationEntryPoint;
    private final ProblemDetailAccessDeniedHandler accessDeniedHandler;

    public SecurityConfig(JwtAuthenticationFilter jwtAuthenticationFilter,
                          ProblemDetailAuthenticationEntryPoint authenticationEntryPoint,
                          ProblemDetailAccessDeniedHandler accessDeniedHandler) {
        this.jwtAuthenticationFilter = jwtAuthenticationFilter;
        this.authenticationEntryPoint = authenticationEntryPoint;
        this.accessDeniedHandler = accessDeniedHandler;
    }

    @Bean
    SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
            .csrf(csrf -> csrf.disable()) // bearer tokens in a header, no cookies: no CSRF risk
            .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
            .cors(cors -> cors.configurationSource(corsConfigurationSource()))
            .httpBasic(basic -> basic.disable())
            .formLogin(form -> form.disable())
            .logout(logout -> logout.disable())
            .authorizeHttpRequests(auth -> auth
                .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login").permitAll()
                .requestMatchers("/actuator/health", "/error").permitAll()
                .requestMatchers(HttpMethod.GET, "/api/books/**", "/api/authors/**", "/api/categories/**").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/books/**").hasRole("ADMIN")
                .requestMatchers(HttpMethod.PUT, "/api/books/**").hasRole("ADMIN")
                .requestMatchers(HttpMethod.DELETE, "/api/books/**").hasRole("ADMIN")
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .anyRequest().authenticated())
            .exceptionHandling(ex -> ex
                .authenticationEntryPoint(authenticationEntryPoint)
                .accessDeniedHandler(accessDeniedHandler))
            .addFilterBefore(jwtAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    /** Prevent Boot from ALSO registering the filter in the plain servlet chain. */
    @Bean
    FilterRegistrationBean<JwtAuthenticationFilter> jwtFilterRegistration(JwtAuthenticationFilter filter) {
        FilterRegistrationBean<JwtAuthenticationFilter> registration = new FilterRegistrationBean<>(filter);
        registration.setEnabled(false);
        return registration;
    }

    /** Exposes the ProviderManager Boot builds from our UserDetailsService + PasswordEncoder. */
    @Bean
    AuthenticationManager authenticationManager(AuthenticationConfiguration configuration) throws Exception {
        return configuration.getAuthenticationManager();
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowedOrigins(List.of("http://localhost:5173"));
        config.setAllowedMethods(List.of("GET", "POST", "PUT", "DELETE", "OPTIONS"));
        config.setAllowedHeaders(List.of("Authorization", "Content-Type"));
        config.setMaxAge(Duration.ofHours(1));
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/api/**", config);
        return source;
    }
}
~~~

Read the rules top to bottom and compare with the table in 1.6. The order matters: the public ^GET^ rule comes before the admin write rules, and ^anyRequest().authenticated()^ is last. If we wrote ^requestMatchers("/api/books/**").hasRole("ADMIN")^ first, nobody could read books anonymously.

### Step 7: DTOs, AuthService and AuthController

~~~java src/main/java/com/example/bookstore/dto/LoginRequest.java
package com.example.bookstore.dto;

import jakarta.validation.constraints.NotBlank;

public record LoginRequest(@NotBlank String username, @NotBlank String password) {
    @Override
    public String toString() {
        return "LoginRequest[username=" + username + ", password=****]";
    }
}
~~~

~~~java src/main/java/com/example/bookstore/dto/TokenResponse.java
package com.example.bookstore.dto;

/** Follows the OAuth2 token response naming convention, so clients feel at home. */
public record TokenResponse(String accessToken, String tokenType, long expiresIn) {

    public static TokenResponse bearer(String token, long expiresInSeconds) {
        return new TokenResponse(token, "Bearer", expiresInSeconds);
    }
}
~~~

^RegisterRequest^ and ^UserResponse^ from Lesson 4.1 are reused unchanged.

~~~java src/main/java/com/example/bookstore/service/AuthService.java
package com.example.bookstore.service;

import com.example.bookstore.dto.LoginRequest;
import com.example.bookstore.dto.TokenResponse;
import com.example.bookstore.security.JwtService;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.stereotype.Service;

@Service
public class AuthService {

    private final AuthenticationManager authenticationManager;
    private final JwtService jwtService;

    public AuthService(AuthenticationManager authenticationManager, JwtService jwtService) {
        this.authenticationManager = authenticationManager;
        this.jwtService = jwtService;
    }

    /** Throws BadCredentialsException (or DisabledException) when login fails. */
    public TokenResponse login(LoginRequest request) {
        Authentication authentication = authenticationManager.authenticate(
                UsernamePasswordAuthenticationToken.unauthenticated(request.username(), request.password()));
        UserDetails user = (UserDetails) authentication.getPrincipal();
        String token = jwtService.generateAccessToken(user);
        return TokenResponse.bearer(token, jwtService.accessTokenTtlSeconds());
    }
}
~~~

We reuse the exact same ^ProviderManager → DaoAuthenticationProvider → AppUserDetailsService → BCrypt^ pipeline from Lesson 4.1. BCrypt now runs **once per login**, not once per request.

~~~java src/main/java/com/example/bookstore/controller/AuthController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.LoginRequest;
import com.example.bookstore.dto.RegisterRequest;
import com.example.bookstore.dto.TokenResponse;
import com.example.bookstore.dto.UserResponse;
import com.example.bookstore.service.AuthService;
import com.example.bookstore.service.UserService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final UserService userService;
    private final AuthService authService;

    public AuthController(UserService userService, AuthService authService) {
        this.userService = userService;
        this.authService = authService;
    }

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public UserResponse register(@Valid @RequestBody RegisterRequest request) {
        return userService.register(request);
    }

    @PostMapping("/login")
    public TokenResponse login(@Valid @RequestBody LoginRequest request) {
        return authService.login(request);
    }
}
~~~

Remove the ^register^ method from ^UserController^ (shown in the next step).

### Step 8: Map login failures and keep 403 intact

Login runs **inside** a controller, so a ^BadCredentialsException^ reaches ^@RestControllerAdvice^, not the entry point. Add these handlers to ^GlobalExceptionHandler^ (existing handlers stay):

~~~java src/main/java/com/example/bookstore/exception/GlobalExceptionHandler.java
// ... existing imports, plus:
// import org.springframework.security.access.AccessDeniedException;
// import org.springframework.security.authentication.BadCredentialsException;
// import org.springframework.security.authentication.DisabledException;

    @ExceptionHandler({BadCredentialsException.class, DisabledException.class})
    public ProblemDetail handleBadLogin(RuntimeException ex) {
        // Same message for both: do not reveal whether the account exists or is disabled.
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.UNAUTHORIZED, "Invalid username or password");
        problem.setTitle("Unauthorized");
        return problem;
    }

    /**
     * If you have a catch-all @ExceptionHandler(Exception.class), it would turn a
     * @PreAuthorize denial into a 500. Rethrow so Spring Security's
     * ExceptionTranslationFilter produces the 403 ProblemDetail.
     */
    @ExceptionHandler(AccessDeniedException.class)
    public void rethrowAccessDenied(AccessDeniedException ex) {
        throw ex;
    }
~~~

### Step 9: Method security and @AuthenticationPrincipal

URL rules already protect book writes. We add ^@PreAuthorize^ on the controller as **defense in depth**, so if someone later loosens a URL rule by mistake, the method is still protected. Only the annotations change in ^BookController^; method bodies remain as in Module 3.

~~~java src/main/java/com/example/bookstore/controller/BookController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.BookRequest;
import com.example.bookstore.dto.BookResponse;
import com.example.bookstore.service.BookService;
import jakarta.validation.Valid;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/books")
public class BookController {

    private final BookService bookService;

    public BookController(BookService bookService) {
        this.bookService = bookService;
    }

    @GetMapping
    public Page<BookResponse> findAll(Pageable pageable) {
        return bookService.findAll(pageable);
    }

    @GetMapping("/{id}")
    public BookResponse findById(@PathVariable Long id) {
        return bookService.findById(id);
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize("hasRole('ADMIN')")
    public BookResponse create(@Valid @RequestBody BookRequest request) {
        return bookService.create(request);
    }

    @PutMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public BookResponse update(@PathVariable Long id, @Valid @RequestBody BookRequest request) {
        return bookService.update(id, request);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasRole('ADMIN')")
    public void delete(@PathVariable Long id) {
        bookService.delete(id);
    }
}
~~~

~~~java src/main/java/com/example/bookstore/controller/UserController.java
package com.example.bookstore.controller;

import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    public record MeResponse(String username, List<String> roles) {}

    /** @AuthenticationPrincipal injects Authentication.getPrincipal(), here the User built by our filter. */
    @GetMapping("/me")
    public MeResponse me(@AuthenticationPrincipal UserDetails currentUser) {
        List<String> roles = currentUser.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .toList();
        return new MeResponse(currentUser.getUsername(), roles);
    }
}
~~~

~~~java src/main/java/com/example/bookstore/controller/AdminController.java
package com.example.bookstore.controller;

import com.example.bookstore.dto.UserResponse;
import com.example.bookstore.repository.UserRepository;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/admin")
@PreAuthorize("hasRole('ADMIN')") // applies to every method in the class
public class AdminController {

    private final UserRepository userRepository;

    public AdminController(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @GetMapping("/users")
    public List<UserResponse> listUsers() {
        return userRepository.findAll().stream().map(UserResponse::from).toList();
    }
}
~~~

(For a large table you would return a ^Page^ via a service, as in Lesson 3.2; kept short here.)

### Step 10: Sketch of the refresh flow

Not fully implemented in this lesson (it is part of Exercise 2), but here is the shape a production implementation takes:

~~~java src/main/java/com/example/bookstore/model/RefreshToken.java
// SKETCH ONLY - entity storing a HASH of an opaque random token
// @Entity @Table(name = "refresh_tokens")
// class RefreshToken {
//     @Id @GeneratedValue Long id;
//     @ManyToOne(optional = false) AppUser user;
//     @Column(nullable = false, unique = true) String tokenHash;   // SHA-256 of the raw token
//     @Column(nullable = false) Instant expiresAt;                 // e.g. now + 14 days
//     boolean revoked;
// }
~~~

~~~text
POST /api/auth/login     -> { accessToken (15 min JWT), refreshToken (random 32 bytes, base64url) }
                            store sha256(refreshToken) with user + expiry
POST /api/auth/refresh   { refreshToken }
                            find by hash; reject if missing, revoked or expired (401)
                            if already used: possible theft -> revoke all tokens of that user
                            mark old one revoked, issue NEW access + NEW refresh (rotation)
POST /api/auth/logout    { refreshToken } -> revoke it (access token dies within 15 min)
~~~

Store only the hash of the refresh token for the same reason we hash passwords: a database leak must not hand out working credentials.

### Step 11: Full walkthrough with PowerShell and curl

Start the app with the secret and the seeded admin from 4.1:

~~~powershell
$env:JWT_SECRET = "cTN0Nnc5eiRDJkYpSkBOY1JmVWpYbjJyNXU4eC9BP0Q="  # demo only; generate your own (section 1.3)
$env:ADMIN_PASSWORD = "Adm1n-Secret!"
./mvnw spring-boot:run
~~~

**1. Register a normal user**

~~~powershell
$body = @{ username = "julian"; email = "julian@example.com"; password = "password123" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/register -ContentType "application/json" -Body $body
# id username email              role createdAt
# -- -------- -----              ---- ---------
#  2 julian   julian@example.com USER 2026-11-20T...
~~~

**2. Log in and capture the token**

~~~powershell
$login = @{ username = "julian"; password = "password123" } | ConvertTo-Json
$resp = Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body $login
$resp
# accessToken                      tokenType expiresIn
# -----------                      --------- ---------
# eyJhbGciOiJIUzI1NiJ9.eyJqdGki... Bearer          900
$userToken = $resp.accessToken
~~~

The same with curl:

~~~powershell
curl.exe -s -X POST http://localhost:8080/api/auth/login -H "Content-Type: application/json" -d '{\"username\":\"julian\",\"password\":\"password123\"}'
# {"accessToken":"eyJhbGciOiJIUzI1NiJ9...","tokenType":"Bearer","expiresIn":900}
~~~

**3. Call a protected endpoint**

~~~powershell
$headers = @{ Authorization = "Bearer $userToken" }
Invoke-RestMethod -Uri http://localhost:8080/api/users/me -Headers $headers
# username roles
# -------- -----
# julian   {ROLE_USER}

curl.exe -i http://localhost:8080/api/users/me -H "Authorization: Bearer $userToken"
# HTTP/1.1 200
~~~

**4. Demonstrate 401: no token, garbage token, wrong password**

~~~powershell
curl.exe -i http://localhost:8080/api/users/me
# HTTP/1.1 401   WWW-Authenticate: Bearer
# {"type":".../unauthorized","title":"Unauthorized","status":401,"detail":"Authentication is required to access this resource.",...}

curl.exe -i http://localhost:8080/api/users/me -H "Authorization: Bearer abc.def.ghi"
# HTTP/1.1 401   "detail":"Access token is invalid"

curl.exe -i -X POST http://localhost:8080/api/auth/login -H "Content-Type: application/json" -d '{\"username\":\"julian\",\"password\":\"nope\"}'
# HTTP/1.1 401   "detail":"Invalid username or password"
~~~

**5. Demonstrate 403: authenticated, but not an admin**

~~~powershell
curl.exe -i -X DELETE http://localhost:8080/api/books/1 -H "Authorization: Bearer $userToken"
# HTTP/1.1 403
# {"type":".../forbidden","title":"Forbidden","status":403,"detail":"You do not have permission to perform this action.","instance":"/api/books/1",...}
~~~

**6. Same request as admin**

~~~powershell
$adminLogin = @{ username = "admin"; password = $env:ADMIN_PASSWORD } | ConvertTo-Json
$adminToken = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/auth/login -ContentType "application/json" -Body $adminLogin).accessToken

curl.exe -i -X DELETE http://localhost:8080/api/books/1 -H "Authorization: Bearer $adminToken"
# HTTP/1.1 204

curl.exe -s http://localhost:8080/api/admin/users -H "Authorization: Bearer $adminToken"
# [{"id":1,"username":"admin",...},{"id":2,"username":"julian",...}]
~~~

**7. Tamper with the token**

Decode the payload, change ^ROLE_USER^ to ^ROLE_ADMIN^, re-encode, and send it. The signature no longer matches, so you get 401 "Access token is invalid". This is the single most convincing demo of why the signature matters.

~~~powershell
$parts = $userToken.Split('.')
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1].Replace('-','+').Replace('_','/').PadRight(($parts[1].Length + 3) - (($parts[1].Length + 3) % 4), '=')))
$json   # readable! never put secrets in the payload
~~~

**8. Token expiry:** set ^bookstore.jwt.access-token-ttl: 1m^ (or ^$env:BOOKSTORE_JWT_ACCESS_TOKEN_TTL="1m"^), log in, wait two minutes (TTL plus the 30-second clock skew), and call ^/api/users/me^: 401 with "Access token has expired".

**Summary of statuses:**

| Request | Status |
|---|---|
| GET /api/books without token | 200 |
| GET /api/users/me without token | 401 |
| GET /api/users/me with tampered or expired token | 401 |
| DELETE /api/books/1 with USER token | 403 |
| DELETE /api/books/1 with ADMIN token | 204 |
| POST /api/auth/login with wrong password | 401 |

---

## 3. Common Pitfalls & Best Practices

- **Hard-coding the JWT secret or giving it a default.** A secret in git or in a default value is public. Fix: read it from ^§{JWT_SECRET}^ with no default, use 32+ random bytes, keep it in a secret manager, and rotate if exposed.
- **Using deprecated jjwt calls.** ^setSigningKey^, ^parseClaimsJws^ and string secrets are pre-0.12 APIs. Fix: ^Jwts.parser().verifyWith(key).build().parseSignedClaims(token)^ and ^signWith(SecretKey)^.
- **Filter registered twice or in the wrong place.** A ^@Component^ filter also runs outside Spring Security, and placing it after authorization means rules never see the user. Fix: ^addFilterBefore(..., UsernamePasswordAuthenticationFilter.class)^ and disable the duplicate ^FilterRegistrationBean^.
- **Writing hasRole('ROLE_ADMIN').** Spring adds the prefix, so it looks for ^ROLE_ROLE_ADMIN^ and always denies. Fix: ^hasRole('ADMIN')^ or ^hasAuthority('ROLE_ADMIN')^.
- **Long-lived access tokens with no revocation story.** Fix: 5-15 minute access tokens, refresh tokens stored hashed in the DB with rotation, and secret rotation as the emergency switch.
- **Putting personal or sensitive data in the payload.** Fix: only subject, roles, issuer, expiry and a jti; look up everything else server-side.
- **Catch-all exception handler swallowing AccessDeniedException.** ^@PreAuthorize^ denials become 500. Fix: rethrow ^AccessDeniedException^ or do not catch ^Exception^ generically.
- **Rolling your own when a standard exists.** Fix: for production with an identity provider, use ^spring-boot-starter-oauth2-resource-server^ and keep custom JWT code for simple self-issued tokens.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): JWT login and RBAC for the Bookstore","tasks":["Add the three jjwt 0.12.6 dependencies, generate a 32-byte Base64 secret in PowerShell and start the app with ^$env:JWT_SECRET^ set. Confirm the app refuses to start when the variable is missing.","Implement ^JwtService^, ^JwtAuthenticationFilter^ and ^AuthController^ as shown, then register, log in and call ^GET /api/users/me^ with the bearer token.","Reproduce every row of the status summary table (200, 401, 403, 204) with curl or ^Invoke-RestMethod^ and save the commands in a ^requests.http^ or script file.","Decode your token's payload without the secret and list every claim it contains. Then tamper with the roles claim and confirm a 401."]},
{"title":"Exercise 2 (Challenge): Refresh tokens with rotation","tasks":["Implement the ^RefreshToken^ entity from the sketch, storing only a SHA-256 hash of a random 32-byte token, and return it from ^/api/auth/login^ alongside the access token.","Add ^POST /api/auth/refresh^ that validates the refresh token, revokes it, and issues a new access and refresh token pair. Return 401 ProblemDetail for unknown, revoked or expired tokens.","Detect reuse: if a revoked refresh token is presented, revoke all refresh tokens of that user and log a security warning (without logging the token).","Add ^POST /api/auth/logout^ and explain in a comment why the current access token still works until it expires."]},
{"title":"Exercise 3 (Extra challenge): Method security and the standard alternative","tasks":["Add a ^Review^ feature where any user can delete their OWN review but an admin can delete any review, using a ^@PreAuthorize^ expression that references a method argument and ^authentication.name^.","Write a test with ^spring-security-test^ (^@WithMockUser(roles = \"USER\")^) proving that ^DELETE /api/books/1^ returns 403, and another with role ADMIN returning 204.","Read the Spring Security reference on OAuth2 Resource Server JWT and list which classes from this lesson it would replace and what you would configure instead.","Write a short paragraph comparing storing the access token in localStorage versus an HttpOnly cookie for a React client, naming the attack each choice exposes you to and its mitigation."]}
]
};
