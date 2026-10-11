# CONTEXT
You are the full-stack developer and system architect building "C.A.R.E. Hub" (Campus Anonymous Reporting & Escalation Hub). C.A.R.E. Hub is a privacy-first, student-centered campus platform where students can anonymously share experiences, report incidents (bullying, cyberbullying, peer pressure, safety hazards, mental health), seek empathetic guidance, and receive peer validation.

### Core Paradigm: Built for Students
C.A.R.E. Hub is strictly designed as an **authentic, native student community social app** (reminiscent of Facebook, Threads, Reddit, or Discord), **NOT** a corporate B2B SaaS landing page or bureaucratic institutional form.

Students avoid reporting incidents on traditional institutional forms because they feel punitive, cold, bureaucratic, and risky. C.A.R.E. Hub eliminates that friction by feeling like a familiar, respectful social feed.

### System Architecture
The application architecture consists of three integrated native web modules:
1. **Public/Semi-Public Student Feed & Inline Composer:** A 3-column native social layout with progressive disclosure, an inline post composer, topic filtering, and supportive hover-dock peer reactions.
2. **Backend Ingestion & Similarity Engine:** Native Node.js services handling automated PII scrubbing, defamation guardrails, 1–5 risk triage scoring, and TF-IDF semantic clustering (detecting recurring hotspots across campus).
3. **C.A.R.E. Adviser & Crisis Safeguards:** An embedded conversational AI assistant for confidential student de-escalation and one-tap report drafting, alongside persistent 24/7 crisis hotlines.

---

# OBJECTIVES
Build a responsive, privacy-first web application and backend service that:
1. **Enables Low-Friction Anonymous Posting:** Allows students to post campus incidents through an inline composer using progressive disclosure, without logging in or exposing personal data.
2. **Abstracts Automated PII Scrubbing:** Automatically detects and redacts names, student IDs, phone numbers, and social handles in real time, displaying a live debounced privacy preview.
3. **Eliminates Defamation & Retaliation:** Automatically filters accusatory call-outs and vengeance language; disables free-form comments in favor of supportive validation reactions (hover reaction dock).
4. **Detects Campus Hotspots via Semantic Similarity:** Clusters similar or recurring reports using text similarity (TF-IDF cosine similarity or vector embeddings) to surface emerging campus patterns without exposing raw accusations.
5. **Triages Critical Safety Incidents:** Automatically evaluates incident urgency (1–5 scale), routing severe incidents (scores 4–5: weapons, self-harm, severe abuse) directly to counselor queues while keeping the public feed safe.
6. **Provides Confidential AI De-Escalation:** Offers a friendly chat companion (C.A.R.E. Adviser) that reduces anxiety and can pre-fill structured report drafts into the inline composer on demand.

---

# DETAILS

### 1. UX Abstraction & 3-Column Native Social Shell (`app-shell`)
The layout adopts a desktop 3-column social structure that collapses cleanly on mobile:

- **Left Column (Navigation & Session Controls):**
  - **Side Navigation:** *Campus Feed*, *My Reports*, *Guidelines & Privacy* (modal trigger), and *Crisis Hotlines* (dialog trigger).
  - **Anonymous Identity Card:** Displays the current browser's transient identifier (e.g., `Student #9155`), a clear note confirming zero account/IP tracking, and a *"New Identity"* button to reset credentials.
  - **Topic Filter Card (`.sidebar-filters`):** Positioned directly below the Anonymous Session card beside the feed. Features clean custom-styled checkboxes:
    - `[✓] All Topics` (master toggle)
    - `[ ] Bullying`
    - `[ ] Cyberbullying`
    - `[ ] Peer Pressure`
    - `[ ] Campus Safety`
    - `[ ] Mental Health`
    - Includes a *"Reset"* button in the header. Supports multi-category filtering simultaneously.
- **Center Column (Community Feed & Inline Composer):**
  - **Inline Post Composer Card:** Positioned at the top of the feed with progressive disclosure (see Section 2).
  - **Posts Stream:** Chronological feed of sanitized student incident cards.
  - **Load More Button:** Pagination trigger for older posts.
- **Right Column (Support & Campus Patterns):**
  - **24/7 Crisis Support Card:** Immediate helpline contacts (NCMH 1553, Campus Security, 911).
  - **Campus Patterns Observed Card:** Real-time incident clusters detected by the similarity engine (e.g., *"Pattern detected: Science Lab Digital Harassment (3 linked reports)"*).
  - **Community Standards Card:** Clear expectations for respectful, good-faith reporting.

---

### 2. Inline Post Composer (Facebook / Reddit Style)
The composer avoids static modal popups or multi-step wizard forms, using inline progressive disclosure:
1. **Collapsed State:**
   - A sleek pill-shaped trigger: Student avatar + button input: *"What's happening on campus? Share anonymously..."*
   - Kept completely minimal. No duplicate shortcut pills or redundant buttons.
2. **Expanded State (Activates on Click):**
   - **Author Header:** Active anonymous avatar + `Student #<hash>` with a clean, understated **`Private`** label (no technical jargon like *"Auto PII scrubbed"* in the user profile line), alongside a Close (×) button.
   - **Controls Row (Side-by-Side 2-Column):**
     - **Incident Category:** A native styled `<select id="category-select">` dropdown list (Bullying, Cyberbullying, Peer Pressure, Campus Safety, Mental Health) with leading shield icon.
     - **Campus Location:** A text input with a `<datalist>` of campus locations (e.g., Science Lab, Cafeteria, Section Discord).
   - **Narrative Textarea:** Minimum 20 characters, maximum 3,000 characters. Live character count.
   - **Real-Time Privacy Preview Box (Debounced):**
     - Automatically renders after 15 characters of typing.
     - Live preview displays the text with PII redactions highlighted in real time (`[Student A]`, `[Phone Removed]`).
     - Displays informational badges if crisis keywords or retaliation language are detected.
   - **Community Standard Checkbox:** Acknowledgment that the post is a good-faith report.
   - **Actions:** *"Discard"* button and *"Post Anonymously"* primary submit button with loading spinner.
   - **State Isolation:** The collapsed bar and expanded form must strictly alternate visibility via CSS `[hidden] { display: none !important; }` so they never render simultaneously.

---

### 3. Supportive Peer Reactions (Hover Reaction Dock)
To prevent victim-blaming, retaliation, and toxic flame wars, **free-form public comments are completely disabled**. Instead, posts feature supportive validation reactions:
- **Available Reactions:**
  - 💙 **Support**
  - 🤝 **Solidarity**
  - 🫂 **You're Not Alone**
  - 👂 **Heard**
- **Hover Dock Architecture (Facebook / Slack Style):**
  - Each post card footer contains a primary Reaction Trigger Button (`.reaction-trigger-btn`) displaying `💙 Support` (or the user's active reaction e.g. `🫂 Not Alone`).
  - **Hover / Focus Dock (`.reactions-dock`):** Hovering over the button smoothly lifts a floating pill dock containing all four reaction emojis.
  - **Micro-Animations:** Hovering individual emojis triggers a 1.35× spring scale animation with a floating tooltip.
  - **Active Reaction Chips (`.reaction-chip`):** Reactions with counts $> 0$ appear as compact clickable badges next to the button (e.g., `🫂 2`, `💙 5`). Clicking an active chip toggles that reaction directly.
  - **Optimistic UI Updates:** Client immediately updates counts and active states before awaiting the server response, rolling back gracefully on network errors.

---

### 4. C.A.R.E. Adviser Floating Chat Drawer
- Fixed floating action button (FAB) at bottom-right labeled *"C.A.R.E. Adviser"*.
- Opens a slide-up drawer for confidential conversational AI support.
- Primary functions:
  1. Active listening, emotional de-escalation, and peer pressure guidance.
  2. Urgent crisis triage: Automatically surfaces hotline phone numbers if self-harm or immediate danger is mentioned.
  3. **"Draft report from chat" Button:** Analyzes the chat conversation, structures it into `{ category, location, narrative }`, closes the chat, expands the inline post composer, and pre-fills the fields for student review.

---

### 5. Client Identity & Security Architecture
- **Mechanism:** Zero server-side accounts or cookies.
- **Client Implementation:** On first load, browser generates a cryptographically random 256-bit hex token in `localStorage` (`care_hub_secret`).
- **Server Implementation:** Client passes token via `X-Author-Secret` HTTP header. The server computes a SHA-256 hash of this secret to produce `anonymous_author_token`.
- **Display Label:** The last 4 hex characters are converted to integer format (e.g., `Student #9155`).
- **Data Isolation:** Resetting the token creates a completely fresh identity. Past reports remain saved under the previous token.

---

### 6. Backend Ingestion Pipeline Modules
When a post is submitted to `POST /api/posts`:
1. **PII & Defamation Scrubbing (`src/pipeline/scrubber.js`):**
   - High-precision regex and heuristic masking:
     - Full names and student names $\rightarrow$ `[Student A]`, `[Student B]`
     - Teacher and faculty names $\rightarrow$ `[Faculty Member]`
     - Phone numbers $\rightarrow$ `[Phone Removed]`
     - Student IDs / ID numbers $\rightarrow$ `[ID Removed]`
     - Social handles (@username) $\rightarrow$ `[Social Handle]`
   - Defamation & retaliation guardrails: Detects accusatory call-outs, character attacks, and vigilante threats. Replaces defamatory phrasing with neutral terms (`[characterization removed]`) or flags the post for moderation review (`pending_moderation`).
2. **Severity Scoring & Triage (`src/pipeline/severity.js`):**
   - Scores incident urgency from 1 to 5 based on keywords and patterns:
     - 1–2: Minor peer conflicts, academic stress.
     - 3: Repeated harassment, social exclusion, physical pranks.
     - 4: Weapon sightings, systemic abuse, cyberstalking with non-consensual media.
     - 5: Imminent self-harm, severe violence threats.
   - **Routing Logic:**
     - Score 1–3: Published to the campus feed in sanitized form.
     - Score 4: Forwarded to student welfare counselors (`flagged_admin`); only a generalized campus notice appears on the public feed.
     - Score 5 (Crisis): Bypasses the public feed entirely; routed privately to crisis counselors.
3. **Similarity & Hotspot Clustering (`src/pipeline/similarity.js`):**
   - TF-IDF cosine similarity and embedding similarity comparison against active posts within a 14-day rolling window.
   - When a match exceeds the similarity threshold ($\ge 0.55$) or shares category and location:
     - Increments `report_count` on the cluster.
     - Updates `last_reported_at`.
     - Surfaces on the right sidebar as an observed campus hotspot.

---

### 7. Database Schema (`SQLite` / `better-sqlite3` in WAL mode)
```sql
-- Incident Posts
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anonymous_author_token TEXT NOT NULL,
  category TEXT NOT NULL,              -- bullying, cyberbullying, peer_pressure, campus_safety, mental_health
  raw_content TEXT NOT NULL,           -- original text (kept secure)
  sanitized_content TEXT NOT NULL,     -- PII-scrubbed version
  public_summary TEXT,                 -- generalized notice for high-severity incidents
  location_tag TEXT NOT NULL,
  severity_score INTEGER NOT NULL,     -- 1 to 5 triage score
  severity_reasons TEXT,               -- JSON array of risk indicators
  cluster_id INTEGER,                  -- Foreign key to incident_clusters
  status TEXT NOT NULL,                -- published, flagged_admin, pending_moderation
  moderation_notes TEXT,
  created_at TEXT NOT NULL
);

-- Incident Clusters (Pattern Detection)
CREATE TABLE IF NOT EXISTS incident_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster_title TEXT NOT NULL,
  incident_type TEXT NOT NULL,
  location_tag TEXT NOT NULL,
  report_count INTEGER NOT NULL DEFAULT 1,
  first_reported_at TEXT NOT NULL,
  last_reported_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' -- active, reviewing, resolved
);

-- Counselor Triage Escalations
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  cluster_id INTEGER,
  severity_level INTEGER NOT NULL,
  summary_brief TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);

-- Supportive Peer Reactions
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  reactor_hash TEXT NOT NULL,
  type TEXT NOT NULL,                  -- support, solidarity, not_alone, heard
  created_at TEXT NOT NULL,
  UNIQUE(post_id, reactor_hash, type)
);
```

# EXAMPLE (End-to-End System Execution)

### 1. Raw Student Post Submission (Inline Composer):
- **User Action:** Student clicks *"What's happening on campus? Share anonymously..."* at the top of the feed.
- **Expanded Inputs:**
  - *Category:* Selects `<select>` option `cyberbullying` ("Cyberbullying").
  - *Location:* Types `Science Lab / Section 3-B Discord`.
  - *Narrative:* `"Mark Santos and his friends from 3-B are sharing private photos of John Doe in our section chat and mocking him during chemistry lab every afternoon."`
- **Real-Time Privacy Preview Box:**
  - Debounced preview immediately renders:
    > `[Student Group A] from [Section] are sharing private photos of [Student B] in our section chat and mocking him during chemistry lab every afternoon.`
  - Badge appears: `2 item(s) protected`.

### 2. Backend Automated Ingestion & Triage:
- **Client Request:** `POST /api/posts` with `X-Author-Secret: a1f8...` header.
- **PII Scrubbing:** Redacts names to generic placeholders (`[Student Group A]`, `[Student B]`).
- **Defamation & Retaliation Check:** Replaces inflammatory accusations; confirms no vigilante call-outs.
- **Severity Scoring:** Detects non-consensual photo distribution and persistent harassment $\rightarrow$ Assigns score `4 / 5`.
- **Similarity Scanning & Hotspot Clustering:**
  - Compares against active database posts via TF-IDF cosine similarity.
  - Matches previous Post #102 (`"Teasing and photo sharing reported in Chem lab"`) with similarity score `0.84`.
  - Links post to `Cluster #24: Science Lab Digital Harassment` and increments `report_count` to 3.
- **Counselor Routing:**
  - Because severity score is 4, flags report as `flagged_admin` for counselor review.
  - Automatically synthesizes generalized campus notice:
    > *"Reports have been noted regarding unauthorized photo sharing and targeted verbal teasing around the Science Lab / section communication channels. This pattern has been logged and forwarded to student welfare services for monitoring."*

### 3. Public Student Feed & Peer Interaction:
- **Feed Card Display:**
  - Displays sanitized post under **Campus Notice**:
    > **Campus Notice** • Science Lab • 12m ago  
    > *"Reports have been noted regarding unauthorized photo sharing and targeted verbal teasing around the Science Lab..."*  
    > 🔍 *Pattern detected: Science Lab Digital Harassment (3 linked reports)*
- **Peer Reaction Dock:**
  - Another student views the card and hovers over `💙 Support`.
  - Floating reaction dock pops up with `💙`, `🤝`, `🫂`, `👂`.
  - Student clicks `🫂 You're Not Alone`.
  - Button smoothly updates to `🫂 You're Not Alone` (highlighted active), and an active pill chip appears beside it: `🫂 1`.
- **Right Sidebar Update:**
  - *Campus Patterns Observed* card now lists:
    > **Science Lab Digital Harassment**  
    > Science Lab • Just now  
    > `3` related reports