LESSONS['7.3']={
md:String.raw`# Lesson 7.3 - Capstone Part 3: Testing, Docker & Ship It

> **Where we stand:** TaskFlow has a versioned schema, a complete REST API with validation, ProblemDetail errors, JWT security with ownership rules, OpenAPI docs, optimistic locking and request-id logging. It works on your machine. This final lesson makes it **trustworthy and shippable**: a test pyramid, a container image, a compose stack, health checks, and a CI pipeline that proves every commit. Then we review production readiness, assess your work, and map what to learn next.

**New files:** tests under ^src/test/java/com/example/taskflow/^, ^Dockerfile^, ^.dockerignore^, ^docker-compose.yml^, ^.github/workflows/ci.yml^. **Changed:** ^application.yml^ (actuator probes, already present; graceful shutdown already on).

---

## 1. Concept & Theory

### 1.1 The test pyramid for a Spring Boot service

| Level | Tool | Spring context? | Speed | What it proves | TaskFlow example |
|---|---|---|---|---|---|
| Unit | JUnit 5 + Mockito | none | ms | business rules, ownership, version checks | ^TaskServiceTest^ |
| Web slice | ^@WebMvcTest^ + MockMvc | MVC + security only | ~1 s | URL mapping, JSON, validation, status codes, error format | ^TaskControllerTest^ |
| Integration | ^@SpringBootTest^ + Testcontainers | full | seconds | real SQL, Flyway, JWT, transactions, locking | ^TaskFlowIntegrationTest^ |
| Smoke (post-deploy) | curl on ^/actuator/health^ | deployed app | seconds | the running container is alive | CI/CD step |

**Analogy:** a car factory tests each bolt (unit), each assembled door (slice), then drives the full car around the track (integration). You want many bolt tests, some door tests, and a few test drives, because test drives are slow and expensive but catch what the parts tests cannot.

### 1.2 What Spring does in each test type

- **^@WebMvcTest(TaskController.class)^** builds a sliced context: only MVC infrastructure, ^@ControllerAdvice^, filters, ^Converter^s, Jackson and Spring Security's auto-config. Services and repositories are **not** created, so you provide them with ^@MockitoBean^ (the Spring Framework 6.2 replacement for the deprecated ^@MockBean^). Because our ^SecurityConfig^ is a ^@Configuration^ class, it is not automatically included; we ^@Import^ it together with the JWT beans so tests exercise our real rules.
- **^@SpringBootTest(webEnvironment = RANDOM_PORT)^** starts the full app on a real port, including Tomcat, Flyway and Hibernate.
- **^@ServiceConnection^** (Boot 3.1+) on a Testcontainers ^PostgreSQLContainer^ makes Boot create ^JdbcConnectionDetails^ from the container, overriding ^spring.datasource.*^. No more ^@DynamicPropertySource^ boilerplate.
- **Context caching:** Spring caches application contexts across test classes with identical configuration. Every distinct combination of ^@MockitoBean^ or properties creates a new context, so keep integration test configuration uniform or your suite slows down dramatically.

### 1.3 Why Testcontainers instead of H2 for integration tests

H2 in PostgreSQL mode is not PostgreSQL. It accepts SQL Postgres rejects, lacks some types (^timestamptz^ semantics, partial indexes, ^ON CONFLICT^), and your Flyway scripts are written for Postgres. Testcontainers starts the **same** ^postgres:16-alpine^ image you run in production, inside Docker, for the test run. "It passed in tests" then actually means something.

### 1.4 Containers: multi-stage builds and layering

A **multi-stage Dockerfile** uses one heavy image (JDK + Maven cache) to build, and a small JRE image to run. The final image contains no compiler, no source code, no Maven: smaller, faster to pull, smaller attack surface.

Spring Boot jars are **layered**: dependencies, spring-boot-loader, snapshot-dependencies, application. Extracting them into separate Docker layers means a code-only change rebuilds and pushes just the few-hundred-KB application layer, while the 60 MB dependencies layer is cached. Boot 3.3+ uses ^java -Djarmode=tools -jar app.jar extract --layers --launcher^ for this.

Runtime best practices baked into our image:

| Practice | Why |
|---|---|
| Run as non-root user | a container escape gives the attacker an unprivileged user |
| ^-XX:MaxRAMPercentage=75^ | JVM sizes its heap from the container memory limit, not the host |
| Exec-form ^ENTRYPOINT^ | Java is PID 1 and receives SIGTERM, enabling graceful shutdown |
| ^HEALTHCHECK^ / probes | orchestrators restart unhealthy containers and route traffic only to ready ones |
| Pinned base image tags | reproducible builds |

### 1.5 Health: liveness vs readiness

With ^management.endpoint.health.probes.enabled=true^ Boot exposes ^/actuator/health/liveness^ ("is the process stuck? restart me") and ^/actuator/health/readiness^ ("can I take traffic right now?"). Readiness includes the DB check by default when you add it to the group; during startup and graceful shutdown readiness reports ^OUT_OF_SERVICE^ so load balancers stop sending requests. Never put external dependencies in **liveness**: a database blip would make Kubernetes restart every pod at once.

### 1.6 Continuous Integration

CI runs on every push and pull request: compile, run all tests (including Testcontainers, since GitHub-hosted Ubuntu runners have Docker), build the image. A red build blocks the merge. The value is not the YAML; it is the **guarantee** that main is always releasable.

---

## 2. Code Walkthrough

### Step 1 - Unit tests for TaskService

No Spring, no database: just the class, with mocked collaborators. We set up the ^SecurityContextHolder^ manually because ^CurrentUser^ reads it.

~~~java src/test/java/com/example/taskflow/task/TaskServiceTest.java
package com.example.taskflow.task;

import com.example.taskflow.common.ResourceNotFoundException;
import com.example.taskflow.project.Project;
import com.example.taskflow.project.ProjectService;
import com.example.taskflow.security.AuthUser;
import com.example.taskflow.task.dto.TaskCreateRequest;
import com.example.taskflow.task.dto.TaskStatusRequest;
import com.example.taskflow.task.dto.TaskUpdateRequest;
import com.example.taskflow.user.Role;
import com.example.taskflow.user.User;
import com.example.taskflow.user.UserRepository;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.LocalDate;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TaskServiceTest {

    @Mock TaskRepository taskRepository;
    @Mock ProjectService projectService;
    @Mock UserRepository userRepository;
    @Spy TaskMapper mapper = new TaskMapper();
    @InjectMocks TaskService taskService;

    User owner;
    User stranger;
    Project project;

    @BeforeEach
    void setUp() {
        owner = user(1L, "owner@x.com", Role.USER);
        stranger = user(2L, "stranger@x.com", Role.USER);
        project = new Project("Capstone", null, owner);
        ReflectionTestUtils.setField(project, "id", 10L);
    }

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("owner can create a task; default priority is MEDIUM")
    void createAsOwner() {
        loginAs(owner);
        when(projectService.load(10L)).thenReturn(project);
        when(taskRepository.saveAndFlush(any(Task.class))).thenAnswer(inv -> withId(inv.getArgument(0), 100L, 0L));

        var response = taskService.create(10L, new TaskCreateRequest("Write tests", null, null, LocalDate.now(), null));

        assertThat(response.id()).isEqualTo(100L);
        assertThat(response.priority()).isEqualTo(TaskPriority.MEDIUM);
        assertThat(response.status()).isEqualTo(TaskStatus.TODO);
    }

    @Test
    void strangerCannotCreateTask() {
        loginAs(stranger);
        when(projectService.load(10L)).thenReturn(project);

        assertThatThrownBy(() -> taskService.create(10L, new TaskCreateRequest("x", null, null, null, null)))
                .isInstanceOf(AccessDeniedException.class);
        verify(taskRepository, never()).saveAndFlush(any());
    }

    @Test
    void adminCanCreateTaskInAnyProject() {
        loginAs(user(99L, "admin@x.com", Role.ADMIN));
        when(projectService.load(10L)).thenReturn(project);
        when(taskRepository.saveAndFlush(any(Task.class))).thenAnswer(inv -> withId(inv.getArgument(0), 101L, 0L));

        assertThat(taskService.create(10L, new TaskCreateRequest("x", null, TaskPriority.HIGH, null, null)).id())
                .isEqualTo(101L);
    }

    @Test
    void staleVersionOnUpdateIsRejected() {
        loginAs(owner);
        Task task = withId(new Task("Old", null, TaskPriority.LOW, null, project, null), 100L, 5L);
        when(taskRepository.findWithDetailsById(100L)).thenReturn(Optional.of(task));

        var stale = new TaskUpdateRequest("New", null, TaskPriority.HIGH, null, null, 4L);

        assertThatThrownBy(() -> taskService.update(100L, stale))
                .isInstanceOf(ObjectOptimisticLockingFailureException.class);
        assertThat(task.getTitle()).isEqualTo("Old");
    }

    @Test
    void assigneeMayChangeStatusButNotUpdateTask() {
        loginAs(stranger);
        Task task = withId(new Task("T", null, TaskPriority.LOW, null, project, stranger), 100L, 0L);
        when(taskRepository.findWithDetailsById(100L)).thenReturn(Optional.of(task));

        var response = taskService.changeStatus(100L, new TaskStatusRequest(TaskStatus.IN_PROGRESS, 0L));
        assertThat(response.status()).isEqualTo(TaskStatus.IN_PROGRESS);

        assertThatThrownBy(() -> taskService.update(100L,
                new TaskUpdateRequest("Hijack", null, TaskPriority.LOW, null, null, 0L)))
                .isInstanceOf(AccessDeniedException.class);
    }

    @Test
    void unknownTaskGives404() {
        loginAs(owner);
        when(taskRepository.findWithDetailsById(404L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> taskService.get(404L))
                .isInstanceOf(ResourceNotFoundException.class)
                .hasMessageContaining("404");
    }

    @Test
    void settingSameStatusIsABusinessRuleViolation() {
        loginAs(owner);
        Task task = withId(new Task("T", null, TaskPriority.LOW, null, project, null), 100L, 0L);
        when(taskRepository.findWithDetailsById(100L)).thenReturn(Optional.of(task));

        assertThatThrownBy(() -> taskService.changeStatus(100L, new TaskStatusRequest(TaskStatus.TODO, 0L)))
                .isInstanceOf(IllegalStateException.class);
    }

    // ---------- helpers ----------

    private static User user(Long id, String email, Role role) {
        User u = new User(email, "hash", role);
        ReflectionTestUtils.setField(u, "id", id);
        return u;
    }

    private static Task withId(Task t, Long id, Long version) {
        ReflectionTestUtils.setField(t, "id", id);
        ReflectionTestUtils.setField(t, "version", version);
        return t;
    }

    private static void loginAs(User u) {
        var principal = new AuthUser(u.getId(), u.getEmail(), "", u.getRole());
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, principal.getAuthorities()));
    }
}
~~~

Why ^ReflectionTestUtils^? Our entities deliberately have no ID or version setters (Hibernate owns them). Using reflection **in tests only** keeps production code honest. The ^@Spy^ on the real mapper means we test the actual DTO mapping rather than mocking trivial code.

### Step 2 - Web slice test for TaskController

~~~java src/test/java/com/example/taskflow/task/TaskControllerTest.java
package com.example.taskflow.task;

import com.example.taskflow.common.RequestIdFilter;
import com.example.taskflow.common.ResourceNotFoundException;
import com.example.taskflow.security.AuthUser;
import com.example.taskflow.security.FilterRegistrationConfig;
import com.example.taskflow.security.JwtAuthFilter;
import com.example.taskflow.security.JwtProperties;
import com.example.taskflow.security.JwtService;
import com.example.taskflow.security.SecurityConfig;
import com.example.taskflow.task.dto.TaskResponse;
import com.example.taskflow.user.Role;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.Pageable;
import org.springframework.http.MediaType;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.user;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@WebMvcTest(TaskController.class)
@Import({SecurityConfig.class, JwtAuthFilter.class, JwtService.class, FilterRegistrationConfig.class})
@TestPropertySource(properties = {
        "app.jwt.secret=dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtMTIzNA==",
        "app.jwt.expiration=PT1H"})
class TaskControllerTest {

    @Autowired MockMvc mvc;
    @MockitoBean TaskService taskService;
    @MockitoBean UserDetailsService userDetailsService;

    private final AuthUser julian = new AuthUser(1L, "julian@example.com", "", Role.USER);

    private TaskResponse sample() {
        return new TaskResponse(5L, "Write tests", null, TaskStatus.TODO, TaskPriority.HIGH, null,
                10L, null, null, 0L, Instant.now(), Instant.now());
    }

    @Test
    void unauthenticatedRequestGets401ProblemDetail() throws Exception {
        mvc.perform(get("/api/tasks/5"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("Content-Type", MediaType.APPLICATION_PROBLEM_JSON_VALUE));
    }

    @Test
    void createReturns201WithLocation() throws Exception {
        when(taskService.create(eq(10L), any())).thenReturn(sample());

        mvc.perform(post("/api/projects/10/tasks").with(user(julian))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"Write tests\",\"priority\":\"HIGH\"}"))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", "http://localhost/api/tasks/5"))
                .andExpect(jsonPath("$.priority").value("HIGH"));
    }

    @Test
    void blankTitleGives400WithFieldError() throws Exception {
        mvc.perform(post("/api/projects/10/tasks").with(user(julian))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.title").value("Validation failed"))
                .andExpect(jsonPath("$.errors.title").exists());
    }

    @Test
    void filtersAreBoundFromQueryParameters() throws Exception {
        when(taskService.list(eq(10L), eq(new com.example.taskflow.task.dto.TaskFilter(TaskStatus.TODO, TaskPriority.HIGH, null)), any(Pageable.class)))
                .thenReturn(new PageImpl<>(List.of(sample())));

        mvc.perform(get("/api/projects/10/tasks?status=TODO&priority=HIGH&sort=dueDate,asc").with(user(julian)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.content[0].id").value(5))
                .andExpect(jsonPath("$.totalElements").value(1));
    }

    @Test
    void unknownSortPropertyGives400() throws Exception {
        mvc.perform(get("/api/projects/10/tasks?sort=passwordHash").with(user(julian)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void optimisticLockConflictGives409() throws Exception {
        when(taskService.changeStatus(eq(5L), any()))
                .thenThrow(new ObjectOptimisticLockingFailureException(Task.class, 5L));

        mvc.perform(patch("/api/tasks/5/status").with(user(julian))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"DONE\",\"version\":0}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.title").value("Concurrent modification"));
    }

    @Test
    void notFoundGives404AndEchoesRequestId() throws Exception {
        when(taskService.get(99L)).thenThrow(new ResourceNotFoundException("Task", 99L));

        mvc.perform(get("/api/tasks/99").with(user(julian)).header(RequestIdFilter.HEADER, "test-req-1"))
                .andExpect(status().isNotFound())
                .andExpect(header().string(RequestIdFilter.HEADER, "test-req-1"))
                .andExpect(jsonPath("$.requestId").value("test-req-1"));
    }
}
~~~

Note: ^jsonPath("$.title")^ uses a dollar followed by a dot, which is perfectly normal JsonPath. ^@WebMvcTest^ includes ^OncePerRequestFilter^ components such as ^RequestIdFilter^ automatically, so the request-id assertion works. ^user(julian)^ from spring-security-test puts our real ^AuthUser^ principal into the context, so code calling ^CurrentUser.get()^ would work too. ^JwtProperties^ is bound because ^SecurityConfig^ carries ^@EnableConfigurationProperties^.

### Step 3 - Integration test with Testcontainers and the real JWT flow

~~~java src/test/java/com/example/taskflow/TestcontainersConfig.java
package com.example.taskflow;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@TestConfiguration(proxyBeanMethods = false)
public class TestcontainersConfig {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgres() {
        return new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    }
}
~~~

~~~java src/test/java/com/example/taskflow/TaskFlowIntegrationTest.java
package com.example.taskflow;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;

import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfig.class)
@ActiveProfiles("test")
class TaskFlowIntegrationTest {

    @Autowired TestRestTemplate rest;

    @Test
    void fullUserJourney() {
        // 1. register + login two users
        String alice = registerAndLogin("alice-" + UUID.randomUUID() + "@example.com");
        String bob = registerAndLogin("bob-" + UUID.randomUUID() + "@example.com");

        // 2. alice creates a project
        ResponseEntity<Map> project = call(HttpMethod.POST, "/api/projects", alice,
                Map.of("name", "Capstone", "description", "Ship it"));
        assertThat(project.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(project.getHeaders().getLocation()).isNotNull();
        Number projectId = (Number) project.getBody().get("id");

        // 3. alice adds a task
        ResponseEntity<Map> task = call(HttpMethod.POST, "/api/projects/" + projectId + "/tasks", alice,
                Map.of("title", "Integration test", "priority", "URGENT"));
        assertThat(task.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Number taskId = (Number) task.getBody().get("id");
        assertThat(((Number) task.getBody().get("version")).longValue()).isZero();

        // 4. bob is not allowed to see alice's project
        assertThat(call(HttpMethod.GET, "/api/projects/" + projectId, bob, null).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // 5. filtering by status/priority works against real SQL
        ResponseEntity<Map> list = call(HttpMethod.GET,
                "/api/projects/" + projectId + "/tasks?status=TODO&priority=URGENT&sort=dueDate,asc", alice, null);
        assertThat(list.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) list.getBody().get("totalElements")).intValue()).isEqualTo(1);

        // 6. optimistic locking: first update wins, second with stale version gets 409
        Map<String, Object> change = Map.of("status", "IN_PROGRESS", "version", 0);
        ResponseEntity<Map> first = call(HttpMethod.PATCH, "/api/tasks/" + taskId + "/status", alice, change);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) first.getBody().get("version")).longValue()).isEqualTo(1L);

        ResponseEntity<Map> second = call(HttpMethod.PATCH, "/api/tasks/" + taskId + "/status", alice,
                Map.of("status", "DONE", "version", 0));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(second.getHeaders().getContentType().toString()).contains("problem+json");

        // 7. no token -> 401, garbage token -> 401
        assertThat(call(HttpMethod.GET, "/api/projects", null, null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(call(HttpMethod.GET, "/api/projects", "not.a.jwt", null).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);

        // 8. delete project cascades to tasks
        assertThat(call(HttpMethod.DELETE, "/api/projects/" + projectId, alice, null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(call(HttpMethod.GET, "/api/tasks/" + taskId, alice, null).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void healthIsUp() {
        ResponseEntity<Map> health = rest.getForEntity("/actuator/health", Map.class);
        assertThat(health.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(health.getBody().get("status")).isEqualTo("UP");
    }

    // ---------- helpers ----------

    private String registerAndLogin(String email) {
        Map<String, String> creds = Map.of("email", email, "password", "password123");
        assertThat(rest.postForEntity("/api/auth/register", creds, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        ResponseEntity<Map> login = rest.postForEntity("/api/auth/login", creds, Map.class);
        assertThat(login.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) login.getBody().get("accessToken");
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> call(HttpMethod method, String url, String token, Object body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (token != null) {
            headers.setBearerAuth(token);
        }
        return rest.exchange(url, method, new HttpEntity<>(body, headers), Map.class);
    }
}
~~~

~~~yaml src/test/resources/application-test.yml
app:
  jwt:
    secret: dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQtMTIzNA==
    expiration: PT15M
spring:
  jpa:
    show-sql: false
~~~

Things worth understanding:

- **Unique emails per test** (UUID) make tests independent of each other and of execution order, without truncating tables.
- The default ^TestRestTemplate^ uses ^HttpURLConnection^, which cannot send PATCH. Add ^org.apache.httpcomponents.client5:httpclient5^ (version managed by Boot) as a test dependency and Boot will use it automatically.
- This one test proves Flyway ran (tables exist), the CHECK constraints accept our enums, BCrypt and JWT work, the entity graph queries are valid SQL, ^ON DELETE CASCADE^ works, and ^@Version^ increments. That is why it is worth its few seconds.
- **Local dev bonus:** create ^src/test/java/com/example/taskflow/TestTaskflowApplication.java^ with ^SpringApplication.from(TaskflowApplication::main).with(TestcontainersConfig.class).run(args)^ and run it to start the app against a throwaway Postgres without any manual Docker command.

~~~xml pom.xml (add inside dependencies)
<dependency>
    <groupId>org.apache.httpcomponents.client5</groupId>
    <artifactId>httpclient5</artifactId>
    <scope>test</scope>
</dependency>
~~~

Run all tests:

~~~powershell
./mvnw verify
~~~

~~~text
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.taskflow.task.TaskServiceTest
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.taskflow.task.TaskControllerTest
Creating container for image: postgres:16-alpine
Container postgres:16-alpine started in PT1.9S
Successfully applied 2 migrations to schema "public", now at version v2
[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0 -- in com.example.taskflow.TaskFlowIntegrationTest
[INFO] BUILD SUCCESS
~~~

### Step 4 - Dockerfile (multi-stage, layered, non-root)

~~~dockerfile Dockerfile
# ---------- build stage ----------
FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /workspace

# Copy build descriptors first so dependency download is cached across code changes
COPY mvnw pom.xml ./
COPY .mvn .mvn
RUN chmod +x mvnw && ./mvnw -B -q dependency:go-offline

COPY src src
RUN ./mvnw -B -q package -DskipTests \
 && java -Djarmode=tools -jar target/taskflow-*.jar extract --layers --launcher --destination target/extracted

# ---------- runtime stage ----------
FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S spring && adduser -S spring -G spring
WORKDIR /app

COPY --from=build /workspace/target/extracted/dependencies/ ./
COPY --from=build /workspace/target/extracted/spring-boot-loader/ ./
COPY --from=build /workspace/target/extracted/snapshot-dependencies/ ./
COPY --from=build /workspace/target/extracted/application/ ./

USER spring:spring
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:8080/actuator/health/liveness || exit 1

ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
~~~

Tests are skipped inside the image build because CI already ran them, and Testcontainers cannot run inside a plain Docker build anyway. ^-XX:+ExitOnOutOfMemoryError^ makes the container die and be restarted cleanly instead of limping along in a broken state.

~~~text .dockerignore
target
.git
.idea
*.iml
.github
docker-compose.yml
~~~

### Step 5 - docker-compose with PostgreSQL

~~~yaml docker-compose.yml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: taskflow
      POSTGRES_USER: taskflow
      POSTGRES_PASSWORD: §{DB_PASSWORD:-taskflow}
    ports:
      - "5432:5432"
    volumes:
      - taskflow-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskflow -d taskflow"]
      interval: 5s
      timeout: 3s
      retries: 10

  app:
    build: .
    image: taskflow:local
    depends_on:
      db:
        condition: service_healthy
    environment:
      SPRING_PROFILES_ACTIVE: prod
      DB_URL: jdbc:postgresql://db:5432/taskflow
      DB_USERNAME: taskflow
      DB_PASSWORD: §{DB_PASSWORD:-taskflow}
      JWT_SECRET: §{JWT_SECRET:?JWT_SECRET must be set}
    ports:
      - "8080:8080"
    deploy:
      resources:
        limits:
          memory: 768m

volumes:
  taskflow-data:
~~~

The ^:?^ form makes Compose refuse to start if ^JWT_SECRET^ is missing, mirroring the prod profile's fail-fast behaviour. Inside the Compose network the app reaches Postgres by **service name** (^db^), not ^localhost^.

~~~powershell
$env:JWT_SECRET = "c3VwZXItc2VjcmV0LXByb2Qta2V5LWZvci10YXNrZmxvdy0zMi1ieXRlcy1taW4="
docker compose up --build -d
docker compose ps
curl -s localhost:8080/actuator/health
curl -s localhost:8080/actuator/health/readiness
docker compose logs -f app
~~~

~~~json
{"status":"UP","groups":["liveness","readiness"]}
~~~

To include the DB in readiness, add to ^application.yml^:

~~~yaml src/main/resources/application.yml (add under management.endpoint.health)
      group:
        readiness:
          include: readinessState,db
~~~

### Step 6 - GitHub Actions CI

~~~yaml .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read

concurrency:
  group: ci-§{{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up JDK 21
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven

      - name: Run tests (unit, slice, Testcontainers)
        run: ./mvnw -B verify

      - name: Upload test reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: surefire-reports
          path: target/surefire-reports

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build Docker image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: false
          tags: taskflow:§{{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
~~~

GitHub's expression syntax is a dollar sign followed by two braces; the course renders the section-sign form as that. ^concurrency^ cancels outdated runs when you push again to the same branch. ^permissions: contents: read^ follows least privilege for the workflow token. Pushing to a registry (GHCR, ECR) is left to Exercise 2.

---

## 3. Common Pitfalls & Best Practices

- **Using H2 for "integration" tests.** Differences in SQL and types hide production bugs. Fix: Testcontainers with the same Postgres version, wired via ^@ServiceConnection^.
- **Using the deprecated ^@MockBean^.** It is deprecated since Boot 3.4. Fix: ^@MockitoBean^ from ^org.springframework.test.context.bean.override.mockito^.
- **Testing only happy paths.** Security bugs live in the unhappy paths. Fix: every protected endpoint has a test for 401, for 403 from another user, and for 404.
- **Shared mutable test data.** Tests pass alone and fail together. Fix: unique data per test (UUID emails) or clean up explicitly; never depend on test order.
- **Fat single-stage images running as root.** Large, slow, insecure. Fix: multi-stage build, JRE base, layers extracted, ^USER^ non-root.
- **Shell-form ENTRYPOINT.** The shell is PID 1 and swallows SIGTERM, so graceful shutdown never happens. Fix: exec-form JSON array.
- **Database checks in the liveness probe.** A DB outage restarts every instance in a loop. Fix: DB only in readiness.
- **Secrets committed in compose or CI files.** Fix: env vars locally, GitHub encrypted secrets in CI, a secret manager in production.

---

## 4. Hands-On Practice

Complete the milestones below on your own. Solutions are only revealed when you ask.

---

## Production-Readiness Checklist

Tick each item honestly before calling TaskFlow "done".

| Area | Check |
|---|---|
| Schema | All DDL in Flyway, ^ddl-auto=validate^, indexes match query patterns |
| Config | No secrets in Git; prod profile has no secret defaults and fails fast |
| Security | BCrypt, JWT secret at least 256 bits, CSRF reasoning documented, ^denyAll^ fallback |
| Authorization | Ownership enforced server-side for every project and task endpoint, tested for 403 |
| Validation | Every request DTO validated; page size capped; sort whitelisted |
| Errors | ProblemDetail everywhere, no stack traces in responses, requestId included |
| Concurrency | ^@Version^ on Task, version required on updates, 409 on conflict |
| Performance | No N+1 on list endpoints (check SQL logs), ^open-in-view=false^ |
| Observability | requestId in logs, health liveness/readiness, info endpoint with build version |
| Tests | Unit, web slice and Testcontainers tests green in CI |
| Container | Multi-stage, non-root, memory-aware JVM, exec-form entrypoint, healthcheck |
| Delivery | CI on every PR, main branch protected, image built per commit |
| Docs | Swagger UI in dev, README with run instructions and env var list |

## Self-Assessment Rubric

Score yourself 1-4 per row. 4 = could explain it in a job interview and implement it without notes.

| Skill | 1 - Beginner | 2 - Developing | 3 - Proficient | 4 - Hero |
|---|---|---|---|---|
| Spring core and DI | copies config | knows beans and injection | explains auto-config and proxies | debugs condition reports and proxy issues |
| REST design | endpoints work | correct verbs and codes | consistent contract, paging, ProblemDetail | designs versioning and evolution strategies |
| JPA and data | entities save | relationships and queries | avoids N+1, uses entity graphs and Specifications | tunes indexes, locking, transactions deliberately |
| Migrations | uses ddl-auto | writes V1 | evolves schema safely with data | plans zero-downtime expand/contract changes |
| Security | permits all | JWT login works | RBAC plus ownership, tested | threat-models and reviews others' auth code |
| Testing | manual curl | some unit tests | pyramid with slices and Testcontainers | fast, reliable suite; tests drive design |
| Ops and delivery | runs in IDE | runs in Docker | compose, health, CI | production deploy with monitoring and rollback |

A total of 21+ means you have genuinely gone from zero to hero. Below 14, revisit the module where you scored lowest and redo its exercises.

## What to Learn Next - Your Roadmap

| Next step | Why it matters | Start with |
|---|---|---|
| Caching with Redis | cut latency and DB load for hot reads | ^spring-boot-starter-data-redis^, ^@Cacheable^, TTLs, cache invalidation on update |
| Messaging with Kafka or RabbitMQ | decouple services, async work, event-driven designs | Spring for Apache Kafka or Spring AMQP; publish a TaskCompleted event; outbox pattern |
| Spring Cloud and microservices | config server, gateway, service discovery, resilience | Spring Cloud Gateway, Resilience4j circuit breakers; first learn when NOT to split a monolith |
| Observability | understand production behaviour across services | Micrometer metrics, Micrometer Tracing with OpenTelemetry, Prometheus and Grafana |
| Kubernetes | run, scale and heal containers in production | Deployments, Services, ConfigMaps/Secrets, probes wired to actuator, Helm |
| Reactive WebFlux | high-concurrency, streaming, non-blocking IO | Project Reactor (Mono and Flux), WebFlux, R2DBC; compare with virtual threads in Java 21 |

> **Suggested order:** observability first (you cannot fix what you cannot see), then Redis caching, then messaging, then Kubernetes, then Spring Cloud. Treat WebFlux as an elective: with Java 21 virtual threads (^spring.threads.virtual.enabled=true^), classic Spring MVC handles very high concurrency too.

Congratulations, Julian. You built a production-grade backend from an empty folder. Ship it, put it on GitHub, and write a README you would be proud to show an interviewer.
`,
exercises:[
{"title":"Exercise 1 (Guided): Prove TaskFlow works","tasks":["Implement ^TaskServiceTest^, ^TaskControllerTest^ and ^TaskFlowIntegrationTest^, then add unit tests for ^ProjectService^ covering owner, stranger and admin.","Acceptance: ^./mvnw verify^ is green locally and the integration test log shows a Postgres container starting and Flyway applying all migrations.","Build the image and run ^docker compose up --build^; acceptance: ^/actuator/health/readiness^ returns UP and the image runs as a non-root user (check with ^docker compose exec app id^).","Push the project to GitHub with the CI workflow and confirm the first run is green, then open a pull request that breaks a test and confirm CI blocks it."]},
{"title":"Exercise 2 (Challenge): Milestone - due-date reminder scheduler and Redis caching","tasks":["Add a ^@Scheduled^ job (cron configurable via a property) that finds tasks due within 24 hours that are not DONE and logs or records one reminder per task per day. Acceptance: running it twice the same day does not create duplicate reminders, and it is covered by a test that does not wait for real time (inject a ^Clock^).","Add Redis caching for ^GET /api/projects/{projectId}^ with ^@Cacheable^ and evict on update and delete. Acceptance: a second GET does not hit Postgres (verify with SQL logs) and an update is visible immediately.","Add a Redis service to ^docker-compose.yml^ and a Testcontainers Redis container for the integration test.","Extend CI to push the image to GitHub Container Registry on main only, using the built-in token and the minimal extra permission it needs."]},
{"title":"Exercise 3 (Thinking): Production review","tasks":["Fill in the production-readiness checklist for your own code and write down every unticked item with a plan to fix it.","Score yourself with the rubric and choose the first item from the roadmap based on your lowest score; justify the choice in three sentences.","Explain what happens to in-flight requests when the container receives SIGTERM, naming the Spring Boot property and the probe state involved.","Describe how you would run two app instances behind a load balancer: what in TaskFlow already supports that (stateless JWT, optimistic locking, Flyway lock) and what would break (the scheduler running twice), and how ShedLock or a similar tool addresses it."]}
]
};
