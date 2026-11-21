/* Course structure. Lesson content lives in js/lessons/lesson-X.Y.js and registers itself in LESSONS. */
var LESSONS={};
var COURSE=[
{title:'Module 1: Foundations & Setup',lessons:[
{id:'1.1',title:'Spring Ecosystem, IoC & Dependency Injection'},
{id:'1.2',title:'Project Setup (Initializr, Maven/Gradle, properties vs YAML)'}]},
{title:'Module 2: Building RESTful APIs',lessons:[
{id:'2.1',title:'Spring MVC, @RestController, Mappings, Path/Query Params'},
{id:'2.2',title:'Request Bodies, Validation & DTOs'},
{id:'2.3',title:'Global Exception Handling (ProblemDetail)'}]},
{title:'Module 3: Persistence with Spring Data JPA',lessons:[
{id:'3.1',title:'Connecting to H2 & PostgreSQL, Entity Mapping'},
{id:'3.2',title:'Repositories, Derived Queries, JPQL, Pagination'},
{id:'3.3',title:'Relationships, Fetching Strategies, @Transactional'}]},
{title:'Module 4: Security & Authentication',lessons:[
{id:'4.1',title:'Spring Security Architecture & Basic Auth'},
{id:'4.2',title:'Stateless JWT & Role-Based Access Control'}]},
{title:'Module 5: Testing & Quality Assurance',lessons:[
{id:'5.1',title:'Unit Testing with JUnit 5 & Mockito'},
{id:'5.2',title:'Integration Testing: SpringBootTest, MockMvc, Testcontainers'}]},
{title:'Module 6: Production Readiness',lessons:[
{id:'6.1',title:'Logging, Profiles & Actuator'},
{id:'6.2',title:'Docker & Docker Compose'}]},
{title:'Module 7: Capstone Project (TaskFlow API)',lessons:[
{id:'7.1',title:'Capstone Part 1: Requirements, Architecture & Domain'},
{id:'7.2',title:'Capstone Part 2: Services, REST API & Security'},
{id:'7.3',title:'Capstone Part 3: Testing, Docker & Ship It'}]},
{title:'Module 8: Advanced Spring Boot (Bonus)',lessons:[
{id:'8.1',title:'Caching with Spring Cache & Redis'},
{id:'8.2',title:'Database Migrations with Flyway & Zero-Downtime Changes'},
{id:'8.3',title:'Messaging & Event-Driven Design (RabbitMQ & Kafka)'},
{id:'8.4',title:'Microservices with Spring Cloud: Gateway, Discovery & Config'},
{id:'8.5',title:'Resilience: Timeouts, Retries, Circuit Breakers (Resilience4j)'},
{id:'8.6',title:'Observability: Micrometer, OpenTelemetry, Prometheus & Grafana'},
{id:'8.7',title:'Concurrency: Virtual Threads, @Async, Scheduling & WebFlux'},
{id:'8.8',title:'CI/CD, Kubernetes & Production Deployment'}]}
];
