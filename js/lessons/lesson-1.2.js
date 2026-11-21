LESSONS['1.2']={
md:String.raw`## 1. Concept & Theory

### Spring Initializr
**start.spring.io** is the official project generator (also built into IntelliJ Ultimate and VS Code's Spring extension). You choose build tool, language, Boot version, Java version, packaging and dependencies, and it generates a ready-to-run skeleton. In production teams, it is how every new service starts, so they all look alike.

Choices that matter:
- **Project:** Maven or Gradle (see below).
- **Language:** Java.
- **Spring Boot:** latest stable 3.x (avoid SNAPSHOT and M versions).
- **Packaging:** **Jar** (embedded server, the modern default). War is only for deploying into an external Tomcat.
- **Java:** 21 (LTS). 17 also works. Boot 3 requires at least 17.
- **Group / Artifact:** ^com.example^ / ^demo^. Group is your reversed domain, artifact is the project name. They also define the base package.

### Maven vs Gradle

| | Maven | Gradle |
|---|---|---|
| Config file | ^pom.xml^ (XML, declarative) | ^build.gradle^ (Groovy) or ^build.gradle.kts^ (Kotlin) |
| Strength | Convention, huge adoption, predictable | Faster incremental builds, flexible scripting |
| Weakness | Verbose XML, less flexible | Steeper learning curve, scripts can get clever |
| Wrapper | ^mvnw^ / ^mvnw.cmd^ | ^gradlew^ / ^gradlew.bat^ |

Both are fully supported. **This course uses Maven**, because it is the most common in enterprise Java. The concepts transfer directly.

**The wrapper** (^mvnw^) downloads the exact Maven version the project needs. Always run ^./mvnw^ (Windows: ^.\mvnw^), not a globally installed ^mvn^, so every developer and the CI server build identically.

### Anatomy of a Spring Boot project

~~~text
demo/
  .mvn/wrapper/               Maven wrapper files
  mvnw, mvnw.cmd              Wrapper scripts (commit these)
  pom.xml                     Build and dependency definition
  src/
    main/
      java/com/example/demo/
        DemoApplication.java  Entry point (root package!)
      resources/
        application.properties  Configuration
        static/               Static files served as-is (HTML, CSS, JS)
        templates/            Server-side templates (Thymeleaf), unused for REST
    test/
      java/com/example/demo/
        DemoApplicationTests.java
  target/                     Build output (never commit; in .gitignore)
~~~

The layout (^src/main/java^, ^src/main/resources^, ^src/test/java^) is a Maven **convention**: tools and every Java developer expect it.

### The pom.xml, line by line
Key parts:
1. **Parent ^spring-boot-starter-parent^.** Supplies dependency version management, sensible plugin configuration and Java compiler settings. This is why you can write a dependency **without a version**: the parent's BOM (Bill of Materials) picks a version tested to work together.
2. **Starters.** One dependency pulls in a whole curated stack.
3. **^spring-boot-maven-plugin^.** Builds the executable "fat JAR" with all dependencies inside, and powers ^spring-boot:run^.

Common starters:

| Starter | Gives you |
|---|---|
| ^spring-boot-starter-web^ | Spring MVC, Jackson (JSON), embedded Tomcat |
| ^spring-boot-starter-validation^ | Bean Validation (Hibernate Validator) |
| ^spring-boot-starter-data-jpa^ | Spring Data JPA + Hibernate |
| ^spring-boot-starter-security^ | Spring Security |
| ^spring-boot-starter-actuator^ | Health checks and metrics |
| ^spring-boot-starter-test^ | JUnit 5, Mockito, AssertJ, Spring Test |
| ^spring-boot-devtools^ | Automatic restart on code changes (dev only) |

### application.properties vs application.yml
Both configure the app and bind to the same property names. Pick one per project.

| | .properties | .yml |
|---|---|---|
| Format | Flat ^key=value^ | Hierarchical, indentation-based |
| Readability | Good for few settings | Better for nested/grouped settings |
| Lists | ^app.hosts[0]=a^ | Natural ^- a^ list syntax |
| Pitfall | Repeated long prefixes | **Indentation errors** (tabs are illegal), more fragile |
| Multi-profile | Separate files | Separate files or multiple documents in one file |

If both files exist, **.properties wins** over .yml for the same key. Don't mix them.

### Configuration sources and precedence (highest wins)
1. Command-line arguments (^--server.port=9090^)
2. OS environment variables (^SERVER_PORT=9090^)
3. Profile-specific files (^application-prod.yml^)
4. ^application.properties/yml^ inside the JAR
5. Defaults in code and in auto-configuration

This is why the **same JAR** runs in dev, test and prod: only the environment changes (the 12-factor app principle).

### Profiles (preview; full coverage in Lesson 6.1)
A profile is a named set of config. Activate with ^spring.profiles.active=dev^ or the env var ^SPRING_PROFILES_ACTIVE=dev^. Files named ^application-dev.yml^ load on top of the base file.

### What ^./mvnw spring-boot:run^ and ^package^ do
- ^spring-boot:run^ compiles and starts the app from the project (development).
- ^package^ produces ^target/demo-0.0.1-SNAPSHOT.jar^, a self-contained executable, run with ^java -jar^. This one artifact is what you put in a Docker image (Lesson 6.2).

## 2. Code Walkthrough

### Step 1: Generate the project
At start.spring.io choose: **Maven, Java, Boot 3.x (latest stable), Group ^com.example^, Artifact ^demo^, Packaging Jar, Java 21**. Add dependencies: **Spring Web**, **Validation**, **Spring Boot DevTools**, **Spring Boot Actuator**. Click Generate, unzip, open in your IDE.

### Step 2: Read the generated pom.xml

~~~xml pom.xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.x.x</version> <!-- whatever Initializr picked -->
        <relativePath/>
    </parent>

    <groupId>com.example</groupId>
    <artifactId>demo</artifactId>
    <version>0.0.1-SNAPSHOT</version>
    <name>demo</name>

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
            <scope>test</scope> <!-- only on the test classpath, not in the shipped JAR -->
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

Notice: **no versions** on the Boot dependencies. The parent manages them.

### Step 3: The entry point

~~~java src/main/java/com/example/demo/DemoApplication.java
package com.example.demo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(DemoApplication.class, args);
    }
}
~~~

### Step 4: Configuration in YAML
Delete ^application.properties^ and create:

~~~yaml src/main/resources/application.yml
server:
  port: 8080                # default; change it to 9090 to see the effect

spring:
  application:
    name: demo

app:
  greeting: Hello from Spring Boot

management:
  endpoints:
    web:
      exposure:
        include: health,info   # expose only what you need
~~~

The equivalent in ^application.properties^:

~~~properties src/main/resources/application.properties
server.port=8080
spring.application.name=demo
app.greeting=Hello from Spring Boot
management.endpoints.web.exposure.include=health,info
~~~

### Step 5: A first endpoint (sneak peek; Module 2 explains it)

~~~java src/main/java/com/example/demo/web/HelloController.java
package com.example.demo.web;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {

    private final String greeting;

    // @Value reads app.greeting. A colon gives a default value if the property is missing.
    public HelloController(@Value("§{app.greeting:Hello}") String greeting) {
        this.greeting = greeting;
    }

    @GetMapping("/hello")
    public String hello() {
        return greeting;
    }
}
~~~

### Step 6: Run, test, package

~~~text
# Windows PowerShell (macOS/Linux: ./mvnw)
.\mvnw spring-boot:run

# In another terminal:
curl http://localhost:8080/hello
curl http://localhost:8080/actuator/health      # {"status":"UP"}

# Override config without editing files:
.\mvnw spring-boot:run "-Dspring-boot.run.arguments=--server.port=9090"

# Build the executable JAR and run it
.\mvnw clean package
java -jar target\demo-0.0.1-SNAPSHOT.jar --app.greeting=Hi
~~~

### Step 7: A profile-specific file

~~~yaml src/main/resources/application-dev.yml
app:
  greeting: Hello from the DEV profile
logging:
  level:
    com.example.demo: DEBUG
~~~

Run it with ^SPRING_PROFILES_ACTIVE=dev^ (PowerShell: ^$env:SPRING_PROFILES_ACTIVE="dev"^) or ^--spring.profiles.active=dev^. The greeting changes, with no code edits.

### Step 8: .gitignore essentials
Commit ^pom.xml^, ^mvnw^, ^.mvn/^ and ^src/^. Never commit ^target/^, ^.idea/^, or any file with real secrets.

## 3. Common Pitfalls & Best Practices

- **Wrong Java version.** A message like "release version 21 not supported" means your JDK is older than ^java.version^. Check ^java -version^ and ^JAVA_HOME^.
- **YAML indentation and tabs.** Use 2 spaces, never tabs. A mis-indented key silently becomes a different property.
- **Main class in the wrong package.** Component scanning starts at its package. Keep it in the root package, with everything else in sub-packages.
- **Committing secrets** (passwords, API keys) in ^application.yml^. Use environment variables or a secrets manager, and commit only safe defaults.
- **Hard-coding versions of Boot-managed dependencies.** This fights the BOM and can create incompatible combinations. Omit the version unless you have a reason.
- **Using the global ^mvn^ instead of the wrapper**, which produces "works on my machine" differences.
- **Port 8080 already in use.** Change ^server.port^ or stop the other process.

## 4. Hands-On Practice

Complete the exercises below. I won't give solutions unless you ask.`,
exercises:[
 {
  "title": "Exercise 1 (Guided): Generate, run and package",
  "tasks": [
   "Generate the project at start.spring.io (Maven, Java 21, Jar; Web, Validation, DevTools, Actuator) and open it in your IDE.",
   "Create ^HelloController^ and ^application.yml^ as shown, then run with ^.\\mvnw spring-boot:run^ and call ^/hello^ and ^/actuator/health^.",
   "Run ^.\\mvnw clean package^, then start the JAR with ^java -jar^ and override ^app.greeting^ from the command line.",
   "Add ^application-dev.yml^ and activate it through an environment variable. Confirm the greeting changes."
  ]
 },
 {
  "title": "Exercise 2 (Challenge): Configuration detective",
  "tasks": [
   "Set ^server.port^ in YAML to 8081, then as the environment variable ^SERVER_PORT=8082^, then as ^--server.port=8083^ together. Predict which wins before each run, then verify. Write down the order you observed.",
   "Add the same key to both ^application.properties^ and ^application.yml^ with different values. Which one wins?",
   "Open the Dependency Hierarchy in your IDE (or run ^.\\mvnw dependency:tree^) and list which libraries ^spring-boot-starter-web^ pulled in. Find the embedded server and the JSON library."
  ]
 },
 {
  "title": "Exercise 3 (Thinking and reading)",
  "tasks": [
   "Find the version of Tomcat your project uses WITHOUT writing it in your pom.xml. Where is it defined?",
   "Explain in two sentences why shipping a fat JAR with an embedded server is better for containers than deploying a WAR to a shared Tomcat.",
   "Read the Spring Boot docs page \"Externalized Configuration\" and list three more config sources beyond those in this lesson."
  ]
 }
]
};
