# CONTEXT
You are the full-stack developer and system architect building "C.A.R.E. Hub" (Campus Anonymous Reporting & Escalation Hub). C.A.R.E. Hub is a social-civic campus platform where students can anonymously share experiences, report incidents (bullying, peer pressure, safety hazards, campus culture issues), and seek advice.

The application architecture consists of three integrated native web modules:
1. Public/Semi-Public Student Feed: A modern social feed where students read and post anonymized campus experiences.
2. Backend Ingestion & Similarity Engine: Native backend services and API routes handling automated content moderation, PII scrubbing, severity scoring, and incident clustering (detecting similar/recurring reports across campus).
3. C.A.R.E. Adviser & Escalation Portal: An embedded conversational AI assistant providing student advice, alongside an administrative incident portal for school authorities and counselors.

# OBJECTIVE
Build a responsive, privacy-first web application and backend service that:
1. Enables anonymous student posting and supportive peer interactions.
2. Automatically scrubs identifying information (PII) and defamatory accusations before publication.
3. Groups and clusters similar or recurring reports using text similarity algorithms to surface campus hotspots and patterns.
4. Triages critical safety incidents and provides structured incident feeds to school administrators without altering school policies or compromising student identities.

# DETAILS

### 1. Functional Architecture & Core Modules
- **Anonymous Post Submission Engine:**
  - Submission form accepting: Incident Category (Bullying, Cyberbullying, Peer Pressure, Campus Safety, Mental Health), Location/Zone (e.g., 3rd Floor Hallway, Online Section Chat, Gym), Narrative Text, and optional attachments.
  - Generates transient, non-identifying author hashes (e.g., "Student #4092") so authors can view updates or follow-ups without storing student IDs or IP addresses.
- **Automated Ingestion, Scrubbing & Clustering Service:**
  - *PII & Defamation Scrubber:* An LLM/regex service that detects and redacts real names, teacher names, social media handles, phone numbers, and student IDs, replacing them with generic tags (e.g., "[Student A]", "[Faculty Member]").
  - *Similarity & Deduplication Engine:* Uses semantic similarity (via embeddings or cosine text similarity) against existing entries in the database. If a new post shares significant semantic overlap (similarity score > 0.80) or matches incident type and location within a rolling 7-day window, link the post to an active "Incident Cluster".
  - *Risk Scoring & Triage:* Computes urgency scores from 1 to 5. Scores $\ge 4$ (threats of violence, self-harm, systemic harassment) bypass public feeds and immediately flag the report for administrator review.
- **C.A.R.E. Adviser Chat Widget:**
  - An embedded conversational assistant that helps students de-escalate anxiety, process peer pressure, or structure messy thoughts into an organized report draft.
- **Authority / Counselor Triage Dashboard:**
  - A clean, read-only administrative portal displaying recurring incident clusters, campus location hotspots, severity badges, and structured, objective incident summaries.

### 2. Data Schema Guidelines (Minimal Viable Schema)
- `posts`: `id`, `anonymous_author_token`, `category`, `raw_content`, `sanitized_content`, `location_tag`, `severity_score`, `cluster_id`, `status` (pending_moderation, published, flagged_admin), `created_at`
- `incident_clusters`: `id`, `cluster_title`, `incident_type`, `location_tag`, `report_count`, `first_reported_at`, `last_reported_at`, `status` (active, reviewing, resolved)
- `escalations`: `id`, `cluster_id` or `post_id`, `severity_level`, `summary_brief`, `sent_to`, `dispatched_at`

# EXAMPLE (End-to-End System Execution)

### 1. Raw Student Post Submission:
- **Input:**
  - *Category:* Bullying / Cyberbullying
  - *Location:* Section 3-B Discord / Science Lab
  - *Narrative:* "Mark Santos and his clique from 3-B are sharing non-consensual photos of John Doe in our group chat and calling him names every afternoon during chemistry lab."

### 2. Backend Automated Processing:
- **Sanitization:**
  - Redacts "Mark Santos" $\rightarrow$ `[Student Group A]`
  - Redacts "John Doe" $\rightarrow$ `[Student B]`
  - Sanitized narrative: `"[Student Group A] from Grade 11 is circulating unauthorized photos of [Student B] in an online group chat and engaging in verbal taunting during laboratory periods."`
- **Similarity Scanning & Clustering:**
  - Evaluates similarity against the active posts table.
  - Matches Post #102 ("Teasing and photo sharing reported in Chem lab") with a similarity score of 0.88.
  - Links post to `Cluster #24: Science Lab Digital Harassment` and increments its incident count.
- **Severity Flagging:**
  - Flags non-consensual photo distribution as High Priority (Score: 4/5).
  - Routes the sanitized record directly to the Counselor Dashboard's priority queue.

### 3. Public Student Feed Output:
- Displays sanitized post under **#CampusSafety**:
  > **Campus Incident Update (Sanitized):**
  > *"Reports have been noted regarding unauthorized photo sharing and targeted verbal teasing around the Science Lab / section communication channels. This pattern has been logged and forwarded to student welfare services for monitoring."*