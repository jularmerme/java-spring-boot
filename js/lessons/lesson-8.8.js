LESSONS['8.8']={
md:String.raw`## 1. Concept & Theory

> **Where TaskFlow stands.** TaskFlow (package ^com.example.taskflow^) has User, Project and Task entities, JWT security, PostgreSQL with Flyway, a Docker Compose stack (lessons 7.1-7.3), and since lesson 8.7 virtual threads, async reports, scheduled jobs with ShedLock and an SSE stream. It runs perfectly on your laptop. This final lesson takes it to **production**: an automated pipeline that builds, tests, scans and publishes an image, and Kubernetes manifests that run it reliably. New files: ^.github/workflows/ci-cd.yml^, ^.github/dependabot.yml^, the ^k8s/^ folder (namespace, configmap, secret, postgres, deployment, service, ingress, hpa, kustomization). Changed files: ^application.yml^ (probes and graceful shutdown), ^Dockerfile^.

### 1.1 CI vs CD vs continuous deployment

| Term | What happens automatically | Human step |
|---|---|---|
| Continuous Integration (CI) | Every push: compile, run unit and integration tests, static checks | Merge decision |
| Continuous Delivery (CD) | Every main commit produces a releasable, tested, versioned artifact deployed to staging | Click "approve" for production |
| Continuous Deployment | Every green main commit goes to production | None, guarded by tests, canaries, monitoring |

Analogy: CI is the kitchen tasting every dish as it is made; continuous delivery is plating it and putting it on the pass; continuous deployment is a waiter who serves it automatically the moment it is ready. Most teams start with continuous delivery: automated to staging, manual approval for production.

Why it matters in production: small, frequent, automated releases are **less risky** than big manual ones. If every change goes through the same pipeline, "it worked on my machine" disappears, and rollbacks are just redeploying a previous immutable image.

### 1.2 The pipeline we build

1. **Build and test** on every push and pull request: Maven with dependency cache, unit tests and Testcontainers integration tests (GitHub's Ubuntu runners have Docker preinstalled, so Testcontainers just works).
2. **Build image** with the Dockerfile from lesson 7.3 and push to **GitHub Container Registry (GHCR)**, only on main.
3. **Tag strategy:** every image gets the immutable short **git SHA** tag (^ghcr.io/julian/taskflow:3f9a1c2^). Never deploy ^latest^ to production: it is mutable, so you cannot tell what is running or roll back reliably. Release tags (^v1.4.0^) are added on git tags.
4. **Scan** the image with **Trivy** for known CVEs in the OS packages and JARs; fail the build on CRITICAL findings.
5. **Deploy to staging** automatically, then **production** after a manual approval through a GitHub **Environment** with required reviewers.
6. **Dependabot** opens pull requests for outdated Maven dependencies, GitHub Actions and Docker base images, so security fixes flow through the same pipeline.

### 1.3 Kubernetes concepts

Kubernetes (K8s) is a **desired-state** system: you declare in YAML "I want 3 copies of TaskFlow image X, reachable at taskflow.example.com", and controllers continuously reconcile reality towards that state. A crashed container is restarted; a dead node's Pods are rescheduled elsewhere.

| Object | Purpose | TaskFlow example |
|---|---|---|
| Pod | Smallest unit: one or more containers sharing network and volumes | One TaskFlow JVM |
| Deployment | Manages ReplicaSets: desired replicas, rolling updates, rollback | taskflow, 3 replicas |
| StatefulSet | Like Deployment but with stable identity and storage | PostgreSQL (local only) |
| Service | Stable virtual IP and DNS name load-balancing to Pods | taskflow, postgres |
| Ingress | HTTP routing from outside (host/path, TLS) via an ingress controller | taskflow.localtest.me |
| ConfigMap | Non-secret configuration as env vars or files | SPRING_PROFILES_ACTIVE, DB_HOST |
| Secret | Sensitive config (base64, encrypt at rest!) | DB_PASSWORD, JWT_SECRET |
| HorizontalPodAutoscaler | Scales replicas from metrics | 2 to 6 replicas at 70% CPU |
| Namespace | Isolation and grouping | taskflow |

### 1.4 Probes and Spring Boot Actuator

Kubernetes asks each container three questions:

| Probe | Question | If it fails | Actuator endpoint |
|---|---|---|---|
| startupProbe | Has the app finished starting? | Keeps waiting, then restarts | /actuator/health/liveness |
| livenessProbe | Is the process broken beyond repair? | Container is restarted | /actuator/health/liveness |
| readinessProbe | Can it serve traffic right now? | Removed from Service endpoints, not restarted | /actuator/health/readiness |

Spring Boot exposes **availability state** as health groups. When it detects Kubernetes (the ^KUBERNETES_SERVICE_HOST^ env var), the probe groups are enabled automatically; we enable them explicitly so they also work locally. Under the hood, ^ApplicationAvailability^ tracks ^LivenessState^ (CORRECT/BROKEN) and ^ReadinessState^ (ACCEPTING_TRAFFIC/REFUSING_TRAFFIC); readiness becomes ACCEPTING only after ^ApplicationReadyEvent^, and switches to REFUSING when shutdown starts.

**Golden rule:** liveness must **not** check the database. If PostgreSQL is down and liveness fails, Kubernetes restarts all your Pods in a loop, which helps nobody. Put the DB check in readiness (optional) so traffic stops flowing to Pods that cannot serve it.

### 1.5 Resources and JVM container awareness

Each container declares **requests** (guaranteed, used for scheduling) and **limits** (hard cap). Exceeding the memory limit gets the container **OOMKilled**; exceeding CPU limit means throttling.

The JVM has been container-aware since Java 10: it reads cgroup limits. But the default max heap is only **25%** of the container memory. Use ^-XX:MaxRAMPercentage=75.0^ so the heap gets most of the memory while metaspace, thread stacks, direct buffers and the code cache fit in the rest. Avoid hard ^-Xmx^ values that drift out of sync with the limit.

| Setting | Recommendation for TaskFlow |
|---|---|
| memory request = limit | 768Mi (equal values avoid surprise OOM under node pressure) |
| cpu request | 500m |
| cpu limit | none or generous (1500m); CPU limits throttle startup and GC |
| JVM | -XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError |

### 1.6 HPA, rolling updates and graceful shutdown

The **HorizontalPodAutoscaler** polls metrics-server and adjusts replicas: desired = ceil(current * currentUtilization / target). CPU utilization is relative to the **request**, so requests must be realistic.

A **rolling update** replaces Pods gradually. With ^maxUnavailable: 0^ and ^maxSurge: 1^, Kubernetes starts one new Pod, waits until it is **ready**, then terminates one old Pod. Zero downtime requires that termination is **graceful**:

1. Kubernetes marks the Pod terminating and removes it from Service endpoints (asynchronously, it takes a few seconds to propagate to all nodes and the ingress).
2. At the same time it runs the ^preStop^ hook, then sends SIGTERM.
3. Spring Boot with ^server.shutdown=graceful^ stops accepting new requests and lets in-flight ones finish for up to ^spring.lifecycle.timeout-per-shutdown-phase^.
4. After ^terminationGracePeriodSeconds^ Kubernetes sends SIGKILL.

Align them: a ^preStop^ sleep of ~10 s (so endpoint removal propagates before Tomcat stops), plus 30 s Spring shutdown, fits inside a grace period of 45 s.

### 1.7 Packaging: Helm and Kustomize

| Tool | Idea | Best for |
|---|---|---|
| Plain YAML | What you write in this lesson | Learning, tiny apps |
| Kustomize | Base YAML plus overlays that patch it per environment; built into kubectl (kubectl apply -k) | Your own apps across dev/staging/prod |
| Helm | Go-templated charts with values.yaml, versioned releases, rollback | Distributing apps, installing third-party software (ingress-nginx, Prometheus) |

### 1.8 GitOps with Argo CD

In **push-based** deployment the CI pipeline runs ^kubectl apply^ and needs cluster credentials. In **GitOps**, a Git repository contains the desired state of the cluster, and an agent inside the cluster (**Argo CD** or Flux) pulls and applies it continuously. Deploying means "commit a new image tag to the config repo". Benefits: an audit trail in Git history, drift detection (manual ^kubectl edit^ is reverted), easy rollback with ^git revert^, and no cluster credentials in CI.

### 1.9 The 12-factor checklist for TaskFlow

| Factor | TaskFlow status |
|---|---|
| 1 Codebase | One Git repo, many deploys |
| 2 Dependencies | Declared in pom.xml, packaged in a fat JAR/image |
| 3 Config | Environment variables via ConfigMap/Secret, placeholders like §{DB_PASSWORD} |
| 4 Backing services | PostgreSQL addressed by URL; swap local for managed |
| 5 Build, release, run | Pipeline builds image once, the same SHA moves through environments |
| 6 Processes | Stateless; JWT instead of HTTP sessions (in-memory report jobs are a known gap) |
| 7 Port binding | Embedded Tomcat on 8080 |
| 8 Concurrency | Scale out with replicas and HPA |
| 9 Disposability | Fast start, graceful shutdown |
| 10 Dev/prod parity | Testcontainers and Docker use real PostgreSQL |
| 11 Logs | Write to stdout as JSON, collected by the platform |
| 12 Admin processes | Flyway migrations at startup or as a Job |

### 1.10 Rollback, blue/green and canary

- **Rollback:** ^kubectl rollout undo^, re-deploying the previous SHA, or ^git revert^ in GitOps. Database changes make this hard: use **expand/contract** migrations (add a column first, deploy code that uses it, remove the old column in a later release) so the previous version still works against the new schema.
- **Blue/green:** run two full environments, switch the Service/Ingress selector from blue to green at once; instant rollback, double resources.
- **Canary:** send 5% of traffic to the new version, watch error rate and latency, then increase; tools are Argo Rollouts, Flagger, or a service mesh.
- **Feature flags:** deploy dark, enable per user; decouple deployment from release.

## 2. Code Walkthrough

### Step 1: Production settings in application.yml

~~~yaml src/main/resources/application.yml (changed parts)
server:
  shutdown: graceful
  forward-headers-strategy: framework   # trust X-Forwarded-* from the ingress

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
  threads:
    virtual:
      enabled: true
  datasource:
    url: jdbc:postgresql://§{DB_HOST:localhost}:§{DB_PORT:5432}/§{DB_NAME:taskflow}
    username: §{DB_USER:taskflow}
    password: §{DB_PASSWORD:secret}
    hikari:
      maximum-pool-size: §{DB_POOL_SIZE:10}

management:
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      probes:
        enabled: true
      group:
        readiness:
          include: readinessState,db
  health:
    livenessstate:
      enabled: true
    readinessstate:
      enabled: true

logging:
  structured:
    format:
      console: ecs     # Spring Boot 3.4+ structured JSON logs to stdout
~~~

Note: ^db^ is in the readiness group only; liveness only reflects the application's own state.

### Step 2: The Dockerfile (container-aware JVM)

~~~dockerfile Dockerfile
# ---- build stage ----
FROM eclipse-temurin:21-jdk AS build
WORKDIR /workspace
COPY .mvn .mvn
COPY mvnw pom.xml ./
RUN ./mvnw -q dependency:go-offline
COPY src src
RUN ./mvnw -q package -DskipTests && \
    java -Djarmode=tools -jar target/taskflow-*.jar extract --layers --launcher --destination extracted

# ---- runtime stage ----
FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 taskflow
WORKDIR /app
COPY --from=build /workspace/extracted/dependencies/ ./
COPY --from=build /workspace/extracted/spring-boot-loader/ ./
COPY --from=build /workspace/extracted/snapshot-dependencies/ ./
COPY --from=build /workspace/extracted/application/ ./
USER 10001
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75.0 -XX:+ExitOnOutOfMemoryError"
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
~~~

Tests are skipped in the image build because the pipeline already ran them; this keeps the image build fast and avoids needing Docker inside Docker for Testcontainers.

### Step 3: The GitHub Actions pipeline

~~~yaml .github/workflows/ci-cd.yml
name: TaskFlow CI/CD

on:
  push:
    branches: [ main ]
    tags: [ 'v*' ]
  pull_request:
    branches: [ main ]

permissions:
  contents: read

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ghcr.io/§{{ github.repository_owner }}/taskflow

concurrency:
  group: ci-§{{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Java 21 with Maven cache
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven

      - name: Build and run all tests (Testcontainers uses the runner's Docker)
        run: ./mvnw -B verify

      - name: Upload test reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: test-reports
          path: target/surefire-reports/

  image:
    needs: build-and-test
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write          # push to GHCR with GITHUB_TOKEN
      security-events: write   # upload Trivy results to the Security tab
    outputs:
      tag: §{{ steps.vars.outputs.sha }}
    steps:
      - uses: actions/checkout@v4

      - name: Compute short SHA
        id: vars
        run: echo "sha=$(git rev-parse --short=7 HEAD)" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: §{{ env.REGISTRY }}
          username: §{{ github.actor }}
          password: §{{ secrets.GITHUB_TOKEN }}

      - name: Docker metadata (tags)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: §{{ env.IMAGE_NAME }}
          tags: |
            type=sha,format=short,prefix=
            type=semver,pattern={{version}}
            type=raw,value=main,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: §{{ steps.meta.outputs.tags }}
          labels: §{{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: §{{ env.IMAGE_NAME }}:§{{ steps.vars.outputs.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          ignore-unfixed: true

      - name: Upload Trivy report
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif

      - name: Fail on CRITICAL vulnerabilities
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: §{{ env.IMAGE_NAME }}:§{{ steps.vars.outputs.sha }}
          severity: CRITICAL
          ignore-unfixed: true
          exit-code: '1'

  deploy-staging:
    needs: image
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: |
          echo "Deploying §{{ env.IMAGE_NAME }}:§{{ needs.image.outputs.tag }} to staging"
          # Push-based: kubectl set image ... using a kubeconfig secret
          # GitOps: commit the new tag to the config repo and let Argo CD sync

  deploy-production:
    needs: [ image, deploy-staging ]
    runs-on: ubuntu-latest
    environment:
      name: production          # configure "Required reviewers" for this environment
      url: https://taskflow.example.com
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to production
        run: echo "Deploying §{{ env.IMAGE_NAME }}:§{{ needs.image.outputs.tag }} to production"
~~~

Remember the app converts the section sign to the real dollar sign, so the GitHub expressions render as the usual dollar-double-brace syntax. Inside the metadata-action tags, ^{{version}}^ without a dollar is the action's own template syntax.

Key points under the hood: ^cache: maven^ caches ^~/.m2/repository^ keyed by the hash of ^pom.xml^; ^GITHUB_TOKEN^ is a short-lived token scoped by the ^permissions^ block (least privilege); the ^environment: production^ job pauses until a reviewer approves in the GitHub UI and can hold environment-specific secrets.

### Step 4: Dependabot

~~~yaml .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: maven
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    groups:
      spring:
        patterns:
          - "org.springframework*"
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directory: "/"
    schedule:
      interval: weekly
~~~

Each Dependabot PR runs through the full CI with Testcontainers, so you merge with confidence.

### Step 5: Kubernetes manifests

Namespace, configuration and secrets:

~~~yaml k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: taskflow
~~~

~~~yaml k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: taskflow-config
  namespace: taskflow
data:
  SPRING_PROFILES_ACTIVE: "prod"
  DB_HOST: "postgres"
  DB_PORT: "5432"
  DB_NAME: "taskflow"
  DB_POOL_SIZE: "10"
~~~

~~~yaml k8s/secret.yaml
# LOCAL DEMO ONLY. Never commit real secrets. In production use
# External Secrets Operator, Sealed Secrets or your cloud's secret manager.
apiVersion: v1
kind: Secret
metadata:
  name: taskflow-secrets
  namespace: taskflow
type: Opaque
stringData:
  DB_USER: "taskflow"
  DB_PASSWORD: "change-me-locally"
  JWT_SECRET: "local-dev-jwt-secret-at-least-32-characters-long"
~~~

PostgreSQL for local clusters. **In production use a managed database** (Amazon RDS, Azure Database for PostgreSQL, Cloud SQL): backups, point-in-time recovery, patching, failover and monitoring are hard to run yourself on Kubernetes.

~~~yaml k8s/postgres.yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: taskflow
spec:
  selector:
    app: postgres
  ports:
    - port: 5432
      targetPort: 5432
  clusterIP: None   # headless service for the StatefulSet
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: taskflow
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: postgres:17-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              valueFrom:
                configMapKeyRef:
                  name: taskflow-config
                  key: DB_NAME
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: taskflow-secrets
                  key: DB_USER
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: taskflow-secrets
                  key: DB_PASSWORD
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "taskflow", "-d", "taskflow"]
            periodSeconds: 5
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              memory: 512Mi
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ "ReadWriteOnce" ]
        resources:
          requests:
            storage: 1Gi
~~~

The TaskFlow Deployment, where probes, resources and graceful shutdown come together:

~~~yaml k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: taskflow
  namespace: taskflow
  labels:
    app: taskflow
spec:
  replicas: 3
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: taskflow
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: taskflow
    spec:
      terminationGracePeriodSeconds: 45
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
      containers:
        - name: taskflow
          image: ghcr.io/julian/taskflow:3f9a1c2   # immutable git SHA tag
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef:
                name: taskflow-config
            - secretRef:
                name: taskflow-secrets
          resources:
            requests:
              cpu: 500m
              memory: 768Mi
            limits:
              memory: 768Mi
          startupProbe:
            httpGet:
              path: /actuator/health/liveness
              port: http
            periodSeconds: 5
            failureThreshold: 30          # up to 150 s to start
          livenessProbe:
            httpGet:
              path: /actuator/health/liveness
              port: http
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /actuator/health/readiness
              port: http
            periodSeconds: 5
            failureThreshold: 3
          lifecycle:
            preStop:
              sleep:
                seconds: 10               # let endpoint removal propagate
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
~~~

The ^preStop.sleep^ action is native since Kubernetes 1.30, so no shell is needed in the image. Tomcat needs a writable ^/tmp^, hence the ^emptyDir^ with a read-only root filesystem.

~~~yaml k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: taskflow
  namespace: taskflow
spec:
  selector:
    app: taskflow
  ports:
    - name: http
      port: 80
      targetPort: http
~~~

~~~yaml k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: taskflow
  namespace: taskflow
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # keep SSE streams open
    nginx.ingress.kubernetes.io/proxy-buffering: "off"
spec:
  ingressClassName: nginx
  rules:
    - host: taskflow.localtest.me     # resolves to 127.0.0.1
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: taskflow
                port:
                  name: http
~~~

~~~yaml k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: taskflow
  namespace: taskflow
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: taskflow
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300   # avoid flapping
~~~

Remember lesson 8.7: 6 replicas times a pool of 10 equals 60 database connections. Check that against your PostgreSQL ^max_connections^ before raising ^maxReplicas^.

~~~yaml k8s/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: taskflow
resources:
  - namespace.yaml
  - configmap.yaml
  - secret.yaml
  - postgres.yaml
  - deployment.yaml
  - service.yaml
  - ingress.yaml
  - hpa.yaml
images:
  - name: ghcr.io/julian/taskflow
    newTag: 3f9a1c2
~~~

A production overlay would live in ^k8s/overlays/prod/kustomization.yaml^, reference ^../../base^, drop ^postgres.yaml^, point ^DB_HOST^ to the managed database and set the new tag. In GitOps, CI only changes ^newTag^ there.

### Step 6: Run it locally with kind (Windows PowerShell)

Install the tools with winget, or enable Kubernetes in Docker Desktop settings instead of kind.

~~~powershell
winget install Kubernetes.kind
winget install Kubernetes.kubectl

# Cluster with ports 80/443 mapped to localhost for the ingress controller
@"
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    labels:
      ingress-ready: "true"
    extraPortMappings:
      - containerPort: 80
        hostPort: 80
      - containerPort: 443
        hostPort: 443
"@ | Set-Content kind-config.yaml

kind create cluster --name taskflow --config kind-config.yaml
kubectl cluster-info --context kind-taskflow

# Ingress controller and metrics-server (for HPA)
kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml
kubectl wait -n ingress-nginx --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=120s
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# Build the image locally and load it into kind (no registry needed)
docker build -t ghcr.io/julian/taskflow:3f9a1c2 .
kind load docker-image ghcr.io/julian/taskflow:3f9a1c2 --name taskflow

# Deploy everything with Kustomize
kubectl apply -k k8s
kubectl get pods -n taskflow -w
~~~

~~~text Expected output (after ~1 minute)
NAME                        READY   STATUS    RESTARTS   AGE
postgres-0                  1/1     Running   0          58s
taskflow-6d9c7f8b5c-2xkqz   1/1     Running   0          58s
taskflow-6d9c7f8b5c-8mtrw   1/1     Running   0          58s
taskflow-6d9c7f8b5c-hn4vd   1/1     Running   0          58s
~~~

Day-to-day kubectl commands:

~~~powershell
Invoke-RestMethod http://taskflow.localtest.me/actuator/health/readiness   # {"status":"UP"}

kubectl logs -n taskflow deploy/taskflow --tail=50 -f
kubectl describe pod -n taskflow -l app=taskflow        # events: probe failures, OOMKilled
kubectl port-forward -n taskflow svc/taskflow 8080:80   # bypass the ingress
kubectl exec -it -n taskflow postgres-0 -- psql -U taskflow -d taskflow -c "select version, description from flyway_schema_history;"
kubectl top pods -n taskflow
kubectl get hpa -n taskflow

# Rolling update to a new image and rollback
kubectl set image -n taskflow deployment/taskflow taskflow=ghcr.io/julian/taskflow:7b21e0d
kubectl rollout status -n taskflow deployment/taskflow
kubectl rollout history -n taskflow deployment/taskflow
kubectl rollout undo -n taskflow deployment/taskflow

# Clean up
kind delete cluster --name taskflow
~~~

Watch a zero-downtime rollout: run ^oha -z 60s -c 50 http://taskflow.localtest.me/actuator/health^ in one window while running ^kubectl rollout restart -n taskflow deployment/taskflow^ in another. With the preStop hook and graceful shutdown you should see zero non-2xx responses; remove the preStop hook and try again to see a few failures.

### Step 7: Helm and Argo CD in one glance

~~~powershell
# Helm: install third-party software, e.g. a Prometheus stack
winget install Helm.Helm
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
~~~

~~~yaml argocd/taskflow-application.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: taskflow-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/julian/taskflow-config.git
    targetRevision: main
    path: k8s/overlays/prod
  destination:
    server: https://kubernetes.default.svc
    namespace: taskflow
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
~~~

### Step 8: What a senior engineer checks before production

- **Build:** reproducible image, immutable SHA tag, non-root user, no secrets in layers, Trivy clean of CRITICAL.
- **Config:** all environment-specific values externalized; secrets from a secret manager; ^ddl-auto: validate^; Flyway migrations backward-compatible.
- **Health:** liveness without DB, readiness with DB, startup probe for slow starts, graceful shutdown aligned with grace period.
- **Capacity:** resource requests from real measurements, ^MaxRAMPercentage^, Hikari pool times replicas below DB ^max_connections^, load test done.
- **Resilience:** at least 2 replicas across nodes, PodDisruptionBudget, timeouts and retries on outgoing calls, scheduled jobs protected with ShedLock.
- **Observability:** structured JSON logs, metrics in Prometheus, dashboards and alerts on error rate, latency p99 and saturation, tracing IDs in logs.
- **Security:** HTTPS at the ingress, CORS restricted, rate limiting, actuator endpoints not public except health, dependencies updated by Dependabot.
- **Data:** automated backups and a **tested** restore, managed database, PII handling documented.
- **Operations:** a runbook, a rollback procedure you have practised, an on-call owner.

### Step 9: Your career roadmap after this course

| Stage | Focus | Concrete next steps |
|---|---|---|
| Junior (now) | Solid Spring Boot, testing, SQL | Finish TaskFlow, deploy it publicly, write a README with architecture diagram |
| Mid-level | Ownership of services in production | Observability (Micrometer, OpenTelemetry), messaging (Kafka), caching (Redis), resilience patterns |
| Senior | System design and trade-offs | Domain-driven design, event-driven architecture, database internals, security deep dive, mentoring |
| Beyond | Architecture and platform | Cloud certification (AWS/Azure/GCP), Kubernetes CKAD, platform engineering, technical leadership |

Keep reading the Spring Boot reference documentation and release notes; build in public; contribute small fixes to open source. You started at zero, you now own a secured, tested, observable, containerized and deployable Spring Boot application. That is what a hero looks like.

## 3. Common Pitfalls & Best Practices

- **Mistake:** Deploying the ^latest^ tag. **Fix:** Deploy immutable git SHA tags and promote the same image through all environments.
- **Mistake:** Liveness probe that checks the database, causing restart storms during a DB outage. **Fix:** Liveness checks only the app state; put ^db^ in the readiness group.
- **Mistake:** No memory limit or a default JVM heap of 25%, leading to OOMKilled Pods or wasted memory. **Fix:** Set request equal to limit for memory and use ^-XX:MaxRAMPercentage=75.0^.
- **Mistake:** Dropped requests during rollouts. **Fix:** ^server.shutdown=graceful^, a preStop sleep, ^maxUnavailable: 0^, and a grace period longer than the sum of both.
- **Mistake:** Committing Kubernetes Secrets with real values to Git. **Fix:** Use External Secrets Operator, Sealed Secrets or a cloud secret manager; keep demo secrets local only.
- **Mistake:** Running a self-managed PostgreSQL StatefulSet in production without backup expertise. **Fix:** Use a managed database service and test restores regularly.
- **Mistake:** Destructive Flyway migrations that make rollback impossible. **Fix:** Expand/contract migrations, so version N-1 runs against schema N.
- **Mistake:** Scaling replicas without considering the database. **Fix:** Pool size times max replicas must stay below the database's connection capacity; consider PgBouncer.

## 4. Hands-On Practice

Complete the exercises below. Solutions are only revealed when you ask.
`,
exercises:[
{"title":"Exercise 1 (Guided): Run TaskFlow on a local Kubernetes cluster","tasks":["Create the kind cluster with the port mappings, install ingress-nginx and metrics-server, and load your TaskFlow image into the cluster.","Apply the manifests with ^kubectl apply -k k8s^ and confirm all Pods become ready and ^/actuator/health/readiness^ returns UP through the ingress.","Delete one TaskFlow Pod with ^kubectl delete pod^ and observe how the Deployment replaces it; note the time until it is ready again.","Perform a rolling update to a new image tag while running a load generator, then roll back with ^kubectl rollout undo^ and record the number of failed requests in both cases."]},
{"title":"Exercise 2 (Challenge): Complete the GitHub Actions pipeline","tasks":["Push TaskFlow to a GitHub repository, add ^.github/workflows/ci-cd.yml^ and make the build-and-test job green including the Testcontainers tests.","Verify that the image appears in GitHub Container Registry tagged with the 7-character git SHA, and that the Trivy results appear in the Security tab.","Create the GitHub Environments staging and production, add yourself as a required reviewer for production, and confirm the pipeline waits for approval.","Read the Kustomize documentation and create ^k8s/overlays/prod^ that removes the PostgreSQL StatefulSet, sets 3 replicas and points ^DB_HOST^ to an external host name."]},
{"title":"Exercise 3 (Thinking): Production readiness review","tasks":["Go through the senior engineer checklist for your TaskFlow and mark each item as done, partially done or missing, with a one-line justification.","Design an expand/contract migration plan for renaming the column ^tasks.title^ to ^tasks.summary^ across three releases without downtime.","Compare blue/green and canary deployment for TaskFlow in terms of cost, risk, rollback speed and required tooling, and recommend one.","Write your personal 12-month learning roadmap with at least four milestones based on the career table in this lesson."]}
]
};
