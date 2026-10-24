flowchart LR
  P(["Patient browser"])
  S(["Staff browser"])
  subgraph V["Vercel, iad1"]
    BK["clinic-web
booking app, BFF
/api proxy, /docs"]
    AD["clinic-admin
admin app, BFF
live feed, notifications"]
  end
  subgraph EXT["Called by the BFF"]
    ID["Google STS + IAM
Vercel OIDC to WIF"]
    RC["reCAPTCHA Enterprise
one check per action"]
    RS["Resend
booking, reminder,
staff and doctor emails"]
  end
  subgraph G["Google Cloud, us-east4"]
    API["clinic-api
FastAPI on Cloud Run
IAM-only, min 0, max 3
every rule, every write
+ outbox relay"]
    RT["clinic-realtime
Go on Cloud Run
IAM-only, 0.25 vCPU
max 2, staff live feed"]
    MIG["clinic-migrate
Cloud Run Job
alembic + seed"]
    SM["Secret Manager"]
  end
  DB[("Neon Postgres
aws-us-east-1")]
  AB["Ably
slots:* events to booking pages
admin:events, no subscriber
no PII on either"]
  CI["CircleCI
OIDC to WIF, keyless
deploys only from main"]
  P --> BK
  S --> AD
  BK --> ID
  BK --> RC
  BK --> RS
  AD --> RS
  BK ==>|"ID token on all calls
+ HMAC on /internal"| API
  AD ==>|"ID token
+ HMAC"| API
  AD ==>|"ID token + staff
assertion; SSE"| RT
  API -->|clinic_app| DB
  RT -->|"clinic_realtime
SELECT only"| DB
  MIG -->|clinic_owner| DB
  SM -.->|secret mount| API
  SM -.-> RT
  SM -.-> MIG
  API -->|"publish"| AB
  CI --> MIG
  CI --> API
  CI --> RT
  CI --> BK
  CI --> AD
