LESSONS['6.2']={
md:String.raw`## 1. Concept & Theory

This is the last lesson of the core course, Julian, and it answers the question every backend developer eventually hits: "How do I ship this thing so it runs the same everywhere?" In lesson 6.1 we made the Bookstore API observable: SLF4J logging with request ids, profiles (^dev^, ^test^, ^prod^ + ^json-logs^), Actuator with liveness/readiness probes on management port 8081, secured endpoints, and graceful shutdown. Now we package the app and its PostgreSQL database into **containers** and start the whole stack with one command.

**New / changed files in this lesson:**

| File | Status |
|---|---|
| Dockerfile | new (multi-stage build) |
| .dockerignore | new |
| compose.yaml | new (app + PostgreSQL) |
| .env.example | new (committed template) |
| .env | new (local only, NOT committed) |
| .gitignore | changed (ignore .env) |
| src/main/resources/application-prod.yml | unchanged, now fed by container env vars |

### 1.1 The analogy: shipping containers

Before the 1950s, cargo was loaded piece by piece: barrels, sacks, crates, each handled differently at every port. The standardized shipping container changed everything: the crane does not care what is inside, every ship and truck handles the same box. A Docker **image** is that standard box for software: your JAR, the exact Java runtime, OS libraries and start command, packed together. Any machine with a container runtime (your Windows laptop, a CI server, a Kubernetes cluster in the cloud) runs it identically. "It works on my machine" becomes "it works in this image", and the image is what you ship.

### 1.2 Containers vs virtual machines

| Aspect | Virtual machine | Container |
|---|---|---|
| Isolation | Full guest OS with its own kernel, on a hypervisor | Shares the host kernel; isolated with namespaces and cgroups |
| Size | Gigabytes | Tens to hundreds of megabytes |
| Startup | Minutes | Seconds (the JVM startup dominates) |
| Density | A few per host | Dozens to hundreds per host |
| Security boundary | Strong | Good, but weaker (shared kernel) |
| Typical use | Running different OSes, legacy systems | Packaging and scaling services |

**Under the hood:** a container is just a normal Linux process with restrictions. **Namespaces** give it its own view of process ids, network interfaces, mounts and hostname, so it thinks it is alone. **cgroups** limit how much CPU and memory it can use. On Windows, Docker Desktop runs a lightweight Linux VM (via WSL 2) and your Linux containers run inside it. That is why containers are fast: no OS boots, a process just starts.

### 1.3 Images and layers

An image is a stack of read-only **layers**. Each instruction in a Dockerfile (^FROM^, ^COPY^, ^RUN^) creates a layer, which is a diff of the filesystem. When the container runs, a thin writable layer is added on top. Layers are content-addressed (identified by a hash) and **cached**: if an instruction and its inputs did not change, Docker reuses the cached layer instead of rebuilding it, and registries only transfer layers the target does not already have.

This leads to the single most important Dockerfile rule: **order instructions from least to most frequently changing.** Once a layer changes, every layer above it is rebuilt. A Spring Boot fat JAR is about 50 MB, of which roughly 49 MB are dependencies (Spring, Hibernate, Tomcat) that rarely change and 1 MB is your code that changes on every commit. If you copy the fat JAR as one layer, every tiny code change produces a new 50 MB layer to build, push and pull. If you split dependencies and code into separate layers, a code change produces a ~1 MB layer. Across hundreds of deployments, that is a big saving in time, bandwidth and registry storage.

### 1.4 Spring Boot layered jars and jarmode

Spring Boot builds layered jars by default. The jar contains a ^BOOT-INF/layers.idx^ file listing four layers, from least to most volatile:

| Layer | Contents | Changes when... |
|---|---|---|
| dependencies | Released third-party jars | You upgrade a library |
| spring-boot-loader | Spring Boot's launcher classes | You upgrade Spring Boot |
| snapshot-dependencies | SNAPSHOT jars | Internal snapshots change |
| application | Your classes and resources | Every commit |

Since Spring Boot 3.3, the recommended command is ^java -Djarmode=tools -jar app.jar extract --layers --launcher^. It runs the jar in a special "tools" mode: instead of starting your app, it unpacks the jar into one folder per layer. (Older articles show ^-Djarmode=layertools ... extract^; that mode is deprecated in 3.3+, so we use ^tools^.) We then ^COPY^ each folder as a separate Docker layer. With ^--launcher^, the extracted layout keeps Spring Boot's ^JarLauncher^, so we start it with ^java org.springframework.boot.loader.launch.JarLauncher^.

### 1.5 Multi-stage builds, JRE images and non-root users

A **multi-stage** Dockerfile uses several ^FROM^ stages. The first stage has the full JDK and Maven wrapper to compile and package; the final stage starts from a slim **JRE** image and copies only the extracted jar layers. The final image contains no compiler, no source code, no Maven cache: smaller (roughly 250 MB instead of 500+ MB) and a much smaller attack surface.

We use **Eclipse Temurin** (the Adoptium build of OpenJDK, free and widely used): ^eclipse-temurin:21-jdk-jammy^ for building and ^eclipse-temurin:21-jre-jammy^ for running. Pin versions in real projects (even a digest), so a rebuild next month does not silently change Java.

By default, processes in a container run as **root**. If an attacker exploits a vulnerability in your app, root inside the container makes escalation and damage much easier. Always create and switch to an unprivileged user with ^USER^. Kubernetes clusters often enforce "runAsNonRoot" and will refuse root images.

### 1.6 Dockerfile vs Cloud Native Buildpacks

Spring Boot can build an image without any Dockerfile: ^.\mvnw spring-boot:build-image^ uses Cloud Native **Buildpacks** (Paketo). It detects a Java app, picks a JRE, creates layers from ^layers.idx^, runs as non-root, and configures JVM memory automatically.

| Criterion | Dockerfile | Buildpacks (spring-boot:build-image) |
|---|---|---|
| Control | Full: every instruction is yours | Opinionated; configured through env vars and plugin config |
| Learning value | High: you see every layer | Low: magic, but production-grade magic |
| Best practices | You must implement them | Built in (layers, non-root, memory calculator, SBOM) |
| Reproducibility | Depends on your discipline | Very good |
| Build requirement | Docker | Docker (builder runs in containers) |
| Good for | Custom OS packages, special tooling, company standards | Teams that want secure defaults with minimal effort |

Rule of thumb: start with Buildpacks if your company has no image standard; write a Dockerfile when you need control or a base image mandated by security. In this lesson we write the Dockerfile, because understanding it makes you able to debug both.

### 1.7 Docker Compose

Our app needs PostgreSQL. Starting each container manually with long ^docker run^ commands is error-prone. **Docker Compose** describes a multi-container application in one YAML file (^compose.yaml^): services, networks, volumes, environment, health checks and startup order. One command, ^docker compose up --build^, builds and starts everything.

Key concepts:

| Concept | Meaning for the Bookstore |
|---|---|
| service | A container definition: ^app^ and ^db^ |
| network | Compose creates a private network; services find each other by **service name** via built-in DNS, so the app connects to ^jdbc:postgresql://db:5432/bookstore^ |
| named volume | Docker-managed storage (^pgdata^) that survives container removal, so data is not lost on restart |
| healthcheck | A command Docker runs periodically to decide if a container is healthy |
| depends_on with condition service_healthy | Start the app only after the DB healthcheck passes |
| .env file | Values for §{VAR} interpolation in compose.yaml; never committed |

**Why ^localhost^ does not work inside a container:** each container has its own network namespace, so ^localhost^ inside the app container is the app container itself, not PostgreSQL. Use the service name ^db^. The port mapping ^5432:5432^ only matters for *your laptop* reaching the DB (e.g. with a DB client); container-to-container traffic uses the internal network.

**Why depends_on alone is not enough:** plain ^depends_on^ only waits until the DB *container started*, not until PostgreSQL *accepts connections* (initialization takes several seconds). The app would crash with "Connection refused". ^condition: service_healthy^ waits for the healthcheck (^pg_isready^) to pass.

### 1.8 The JVM inside a container

Since Java 10, the JVM is **container-aware**: it reads the cgroup memory and CPU limits instead of the host's. But the default max heap is only **25%** of the container memory, which wastes most of a 512 MB container. We set ^-XX:MaxRAMPercentage=75.0^: heap may use up to 75%, leaving 25% for non-heap memory (metaspace, thread stacks, code cache, direct buffers, GC structures). Do not go to 100%: if total JVM memory exceeds the container limit, the kernel's OOM killer terminates the process with exit code **137**, with no Java stack trace at all. We pass flags through ^JAVA_TOOL_OPTIONS^, which the JVM reads automatically, so they can be changed at runtime without rebuilding the image.

### 1.9 Graceful shutdown in containers

^docker stop^ (and ^docker compose down^) sends SIGTERM to **PID 1** in the container, waits 10 seconds, then sends SIGKILL. Two things must be right for the graceful shutdown from lesson 6.1 to work:

1. Java must be PID 1, so it actually receives SIGTERM. Use the **exec form** ^ENTRYPOINT ["java", ...]^. The shell form (^ENTRYPOINT java ...^) wraps Java in ^/bin/sh -c^, which may not forward signals: your app gets killed abruptly after 10 seconds.
2. The grace period must exceed ^spring.lifecycle.timeout-per-shutdown-phase^ (20s). Compose's ^stop_grace_period: 30s^ does that.

### 1.10 Health checks with Actuator

Docker can only report "running" unless you give it a health check. We probe Actuator's readiness endpoint on the management port: ^http://localhost:8081/actuator/health/readiness^ (inside the container, ^localhost^ is correct, because the check runs in the app container itself). The slim JRE image has no ^curl^, so we either install it (adding size and attack surface) or define the check in Compose with a tool that exists. We install a tiny ^curl^ in the runtime stage for clarity; an alternative is a small Java health-check program. In Kubernetes, you would not use ^HEALTHCHECK^ at all; Kubernetes uses its own ^livenessProbe^/^readinessProbe^ against the same Actuator URLs.

---

## 2. Code Walkthrough

### Step 0: prerequisites (Windows)

Install **Docker Desktop** with the WSL 2 backend and start it (the whale icon in the tray must say "running"). Verify in PowerShell:

~~~powershell
docker version
docker compose version
~~~

Both must show a client **and** a server section. If the server part errors, Docker Desktop is not running.

### Step 1: .dockerignore

The **build context** is the folder you send to the Docker daemon. Without ^.dockerignore^, you send ^target/^, ^.git/^, IDE folders and maybe ^.env^ secrets, which slows builds, breaks caching and can leak secrets into images.

~~~text .dockerignore
target/
.git/
.gitignore
.idea/
.vscode/
*.iml
*.log
.env
.env.*
!.env.example
compose.yaml
Dockerfile
config/secrets.yml
HELP.md
~~~

### Step 2: the multi-stage Dockerfile

~~~dockerfile Dockerfile
# syntax=docker/dockerfile:1

############################
# Stage 1: build the jar
############################
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /workspace

# 1) Maven wrapper and pom first: changes rarely, so this layer is cached
COPY mvnw .
COPY .mvn .mvn
COPY pom.xml .
# fix Windows line endings and make the wrapper executable
RUN sed -i 's/\r$//' mvnw && chmod +x mvnw
# download dependencies into a cache mount (reused across builds)
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -q dependency:go-offline

# 2) source code: changes often
COPY src src
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -q package -DskipTests

############################
# Stage 2: extract layers
############################
FROM eclipse-temurin:21-jdk-jammy AS extract
WORKDIR /extract
COPY --from=build /workspace/target/*.jar app.jar
RUN java -Djarmode=tools -jar app.jar extract --layers --launcher --destination extracted

############################
# Stage 3: runtime image
############################
FROM eclipse-temurin:21-jre-jammy AS runtime

# curl only for the HEALTHCHECK; clean apt lists to keep the layer small
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# unprivileged user
RUN groupadd --system spring && useradd --system --gid spring --no-create-home spring

WORKDIR /app

# least-changing layers first
COPY --from=extract --chown=spring:spring /extract/extracted/dependencies/ ./
COPY --from=extract --chown=spring:spring /extract/extracted/spring-boot-loader/ ./
COPY --from=extract --chown=spring:spring /extract/extracted/snapshot-dependencies/ ./
COPY --from=extract --chown=spring:spring /extract/extracted/application/ ./

USER spring

ENV SPRING_PROFILES_ACTIVE=prod \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError"

# 8080 = API, 8081 = management (actuator)
EXPOSE 8080 8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=40s --retries=3 \
  CMD curl -fs http://localhost:8081/actuator/health/readiness || exit 1

# exec form: java is PID 1 and receives SIGTERM for graceful shutdown
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
~~~

Walkthrough of the important decisions:

- **Wrapper and pom before src:** dependency download (the slow part, often minutes) is cached until ^pom.xml^ changes. Editing a controller only re-runs the last ^package^ step.
- **^RUN --mount=type=cache^:** a BuildKit feature (default in Docker Desktop) that keeps the Maven repository between builds without baking it into a layer.
- **^sed^ on mvnw:** when you clone on Windows, git may convert ^mvnw^ to CRLF line endings, and Linux then fails with "/bin/sh bad interpreter" style errors. Stripping carriage returns makes the build robust.
- **The extract stage:** runs ^jarmode=tools^ and produces four folders. The runtime stage copies them in order of volatility.
- **^-XX:+ExitOnOutOfMemoryError^:** if the heap is exhausted, exit immediately so Docker/Kubernetes restarts a clean instance, instead of limping along in a broken state.
- **^SPRING_PROFILES_ACTIVE=prod^ as default:** the image is production-ready by default; you can override it at runtime.

### Step 3: build and inspect the image

~~~powershell
docker build -t bookstore:0.1.0 .
docker images bookstore
docker history bookstore:0.1.0
~~~

Expected (sizes vary):

~~~text
REPOSITORY   TAG     IMAGE ID       CREATED          SIZE
bookstore    0.1.0   3f1c9a2b7d10   20 seconds ago   298MB
~~~

Now change one line in ^BookController^ and rebuild. In the output, the dependency steps show ^CACHED^ and only the ^package^ step and the final ^application^ layer are rebuilt. ^docker history^ shows the application layer is only a few hundred KB. That is the payoff of layering.

### Step 4: run the container alone (with env vars)

Without Compose, you would run PostgreSQL on your laptop and point the container at it. On Docker Desktop, the special hostname ^host.docker.internal^ reaches your Windows host:

~~~powershell
docker run --rm --name bookstore -p 8080:8080 -p 8081:8081 --memory=512m -e SPRING_DATASOURCE_URL=jdbc:postgresql://host.docker.internal:5432/bookstore -e SPRING_DATASOURCE_USERNAME=bookstore -e SPRING_DATASOURCE_PASSWORD=bookstore bookstore:0.1.0
~~~

Relaxed binding (lesson 6.1) maps ^SPRING_DATASOURCE_URL^ onto ^spring.datasource.url^, which our ^application-prod.yml^ references with ^§{SPRING_DATASOURCE_URL}^. You will see JSON logs (profile group ^prod^ includes ^json-logs^). Check the health status Docker computed:

~~~powershell
docker ps --format "table {{.Names}}\t{{.Status}}"
~~~

~~~text
NAMES       STATUS
bookstore   Up 52 seconds (healthy)
~~~

### Step 5: the alternative, Buildpacks

~~~powershell
.\mvnw spring-boot:build-image "-Dspring-boot.build-image.imageName=bookstore:0.1.0-bp"
~~~

No Dockerfile needed. The resulting image is layered, runs as a non-root user and uses the Paketo memory calculator. Run it with the same ^docker run^ command and compare sizes and startup logs. Keep using one approach consistently in a real project.

### Step 6: secrets in a .env file

Compose automatically reads a file named ^.env^ next to ^compose.yaml^ and uses it for §{...} interpolation. It holds real local passwords, so it is never committed. We commit a template instead.

~~~properties .env.example
# Copy to .env and change the values. Never commit .env.
POSTGRES_DB=bookstore
POSTGRES_USER=bookstore
POSTGRES_PASSWORD=change-me
APP_PORT=8080
~~~

~~~properties .env
POSTGRES_DB=bookstore
POSTGRES_USER=bookstore
POSTGRES_PASSWORD=s3cr3t-local-only
APP_PORT=8080
~~~

~~~text .gitignore (append)
.env
config/secrets.yml
~~~

Create your copy in PowerShell with ^Copy-Item .env.example .env^, then edit it.

### Step 7: compose.yaml

~~~yaml compose.yaml
name: bookstore

services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: §{POSTGRES_DB}
      POSTGRES_USER: §{POSTGRES_USER}
      POSTGRES_PASSWORD: §{POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}
    ports:
      - "5432:5432"        # only for tools on your laptop; remove in real prod
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: bookstore:0.1.0
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      SPRING_PROFILES_ACTIVE: prod
      SPRING_DATASOURCE_URL: jdbc:postgresql://db:5432/§{POSTGRES_DB}
      SPRING_DATASOURCE_USERNAME: §{POSTGRES_USER}
      SPRING_DATASOURCE_PASSWORD: §{POSTGRES_PASSWORD}
      JAVA_TOOL_OPTIONS: "-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError"
    ports:
      - "§{APP_PORT:-8080}:8080"
      - "127.0.0.1:8081:8081"   # actuator only reachable from this machine
    deploy:
      resources:
        limits:
          memory: 512m
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:8081/actuator/health/readiness"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 40s

volumes:
  pgdata:
~~~

Details worth understanding:

- **^$$POSTGRES_USER^:** the double dollar escapes Compose interpolation, so the variable is expanded by the shell *inside* the DB container, where ^POSTGRES_USER^ is set.
- **The ^:?^ form:** makes Compose fail immediately with a clear message if the password is missing, instead of starting a database with an empty password.
- **^db^ in the JDBC URL:** service-name DNS on the Compose network.
- **^127.0.0.1:8081:8081^:** publishes the management port to your machine only, never to your LAN. This mirrors "actuator on an internal network" from lesson 6.1.
- **^deploy.resources.limits.memory^:** gives the JVM a real limit to compute 75% from; without it the container could use all of Docker Desktop's memory.
- **Healthcheck in Compose** overrides the Dockerfile ^HEALTHCHECK^; having it here keeps all runtime behavior in one visible file.
- **^ddl-auto: validate^ in prod:** Hibernate will not create tables. On a fresh volume the schema must exist. Use Flyway or Liquibase in real projects (add ^flyway-core^ and ^flyway-database-postgresql^ and a ^V1__init.sql^ migration); for a first try you can temporarily set ^SPRING_JPA_HIBERNATE_DDL_AUTO: update^ in the app environment.

### Step 8: run the stack

~~~powershell
docker compose up --build -d
docker compose ps
docker compose logs -f app
~~~

Expected ^docker compose ps^ output once started:

~~~text
NAME              IMAGE             SERVICE   STATUS                    PORTS
bookstore-db-1    postgres:16       db        Up 45 seconds (healthy)   0.0.0.0:5432->5432/tcp
bookstore-app-1   bookstore:0.1.0   app       Up 33 seconds (healthy)   0.0.0.0:8080->8080/tcp, 127.0.0.1:8081->8081/tcp
~~~

The app container only starts after the DB is healthy. Test it:

~~~powershell
curl.exe -i http://localhost:8080/api/books
curl.exe http://localhost:8081/actuator/health
curl.exe -u admin:admin123 -X POST -H "Content-Type: application/json" -d '{\"title\":\"Spring in Action\",\"isbn\":\"9781617294945\",\"price\":49.99,\"publishedYear\":2022}' http://localhost:8080/api/books
~~~

Expected: ^HTTP/1.1 200^ with a JSON page of books, health ^{"status":"UP","groups":["liveness","readiness"]}^ and ^HTTP/1.1 201^ for the POST, with a JSON log line in ^docker compose logs app^ containing ^Created book id=...^ and a ^requestId^.

Persistence test: ^docker compose down^ then ^docker compose up -d^. The book is still there, because the named volume ^pgdata^ survived. Now graceful shutdown: run ^docker compose stop app^ and read the logs: ^Commencing graceful shutdown^ ... ^Graceful shutdown complete^, within the 30 s grace period.

Useful commands:

| Command | Effect |
|---|---|
| docker compose up --build | Rebuild images if needed and start all services |
| docker compose up -d | Start in background (detached) |
| docker compose logs -f app | Follow the logs of one service |
| docker compose ps | Status and health of services |
| docker compose exec db psql -U bookstore -d bookstore | Open a SQL shell in the DB container |
| docker compose stop | Stop containers (keep them) |
| docker compose down | Remove containers and network, keep volumes |
| docker compose down -v | Also delete named volumes: ALL DATA IS LOST |

### Step 9: common Windows and Docker Desktop issues

| Symptom | Cause | Fix |
|---|---|---|
| error during connect / pipe docker_engine not found | Docker Desktop not running | Start Docker Desktop, wait for "Engine running" |
| ./mvnw: not found or bad interpreter during build | CRLF line endings in mvnw | Our ^sed^ step fixes it; or set ^git config core.autocrlf input^ |
| port is already allocated on 5432 | A local PostgreSQL service already uses 5432 | Stop the Windows service or map ^"5433:5432"^ |
| App logs Connection refused to localhost:5432 | Using localhost inside a container | Use the service name ^db^ (or ^host.docker.internal^ for the host) |
| Container exits with code 137 | OOM killed: memory limit too low or heap too large | Raise the limit or lower ^MaxRAMPercentage^ |
| Very slow builds, huge context | Missing .dockerignore, sending target/ and .git/ | Add the .dockerignore from Step 1 |
| Changes in .env have no effect | Containers not recreated | Run ^docker compose up -d^ again (it recreates changed services) |
| WSL 2 uses too much RAM | Default WSL memory settings | Limit memory in ^%UserProfile%\.wslconfig^ with ^[wsl2]^ and ^memory=4GB^ |
| curl in PowerShell behaves strangely | ^curl^ is an alias for Invoke-WebRequest | Use ^curl.exe^ |

### Step 10: what comes next

You now have an immutable, versioned image and a reproducible local environment. The next steps in a real career:

- **CI/CD:** a pipeline (GitHub Actions, GitLab CI, Jenkins) runs ^.\mvnw verify^ (your module 5 tests, including Testcontainers), builds the image, scans it for vulnerabilities (Trivy, Docker Scout), tags it with the git commit SHA and pushes it to a registry (Docker Hub, GHCR, ECR). Deployments then promote that **same image** from staging to production.
- **Kubernetes:** runs many replicas of your image, restarts failed ones using ^/actuator/health/liveness^, routes traffic only to ready ones via ^/actuator/health/readiness^, injects configuration through ConfigMaps and passwords through Secrets (the same env vars and configtree you learned), scrapes ^/actuator/prometheus^, and does rolling updates that rely on graceful shutdown. Everything you built in module 6 is exactly what Kubernetes expects from a well-behaved app.

---

## 3. Common Pitfalls & Best Practices

- **Mistake:** copying the fat jar as one layer, so every code change ships 50 MB. **Fix:** extract with ^java -Djarmode=tools -jar app.jar extract --layers --launcher^ and copy layers from least to most volatile.
- **Mistake:** shipping the JDK, Maven and source code in the final image. **Fix:** multi-stage build; final stage based on ^eclipse-temurin:21-jre^ with only the extracted jar.
- **Mistake:** running the app as root. **Fix:** create a system user and switch with ^USER spring^.
- **Mistake:** baking passwords into the image with ^ENV^ or committing ^.env^. **Fix:** pass secrets at runtime; commit only ^.env.example^; add ^.env^ to ^.gitignore^ and ^.dockerignore^.
- **Mistake:** using ^localhost^ in the JDBC URL inside a container, or plain ^depends_on^ without a health condition. **Fix:** use the service name ^db^ and ^condition: service_healthy^ with a ^pg_isready^ healthcheck.
- **Mistake:** shell-form ^ENTRYPOINT^, so Java never receives SIGTERM and graceful shutdown is skipped. **Fix:** exec form ^ENTRYPOINT ["java", ...]^ and a grace period longer than the Spring shutdown timeout.
- **Mistake:** no memory limit or default heap settings, leading to wasted memory or exit code 137. **Fix:** set a container memory limit and ^-XX:MaxRAMPercentage=75.0^ via ^JAVA_TOOL_OPTIONS^.
- **Mistake:** running ^docker compose down -v^ casually. **Fix:** remember ^-v^ deletes named volumes and all database data; use plain ^down^ unless you want a clean slate.

---

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Containerize the Bookstore","tasks":["Write the ^.dockerignore^ and multi-stage ^Dockerfile^, build ^bookstore:0.1.0^, and record the image size shown by ^docker images^.","Change one string in ^BookController^, rebuild, and identify in the build output which steps were ^CACHED^; use ^docker history^ to find the size of the application layer.","Create ^.env^ from ^.env.example^, start the stack with ^docker compose up --build -d^, and verify both services become ^(healthy)^.","Create a book with POST, run ^docker compose down^ and ^up -d^, and confirm the book still exists; then explain what ^down -v^ would have done."]},
{"title":"Exercise 2 (Challenge): Production-grade schema and images","tasks":["Add Flyway (^flyway-core^ and ^flyway-database-postgresql^) with a ^V1__init.sql^ migration for books, authors and categories, so the prod profile works with ^ddl-auto: validate^ on a fresh volume.","Build the same app with ^.\\mvnw spring-boot:build-image^ and compare image size, user, startup time and memory settings against your Dockerfile image.","Replace the curl-based healthcheck with an approach that does not install curl in the runtime image, and justify your choice.","Run the app container with a 256m memory limit and observe what happens; adjust ^MaxRAMPercentage^ or the limit until it runs stably, and record the values you found."]},
{"title":"Exercise 3 (Thinking): Beyond Docker Compose","tasks":["Explain why an image should be built once and promoted through environments instead of rebuilt per environment, and how profiles and environment variables make that possible.","Sketch the steps of a CI/CD pipeline for the Bookstore, from git push to a running container, naming where tests, image scanning and tagging happen.","Map each element of our ^compose.yaml^ (healthcheck, depends_on, environment, volumes, .env) to the Kubernetes concept that would replace it.","Describe what happens, second by second, when ^docker compose stop app^ is run while a POST request is in progress, and what would change with a shell-form ENTRYPOINT."]}
]
};
