# Custom slash commands

Save reusable prompts in the composer's **/ commands → Manage commands…** editor,
or **Manage commands…** in the command palette (⌘K / Ctrl-K).
Give each command a lowercase, hyphen-separated name without the leading slash,
an optional description, and a prompt body. `/clear` is reserved.

Commands can be app-wide or limited to the current project. Names are unique within
each scope; a project command overrides an app-wide command with the same name.
The editor lists both definitions so each can be edited or deleted. Deleting a
project also deletes its scoped commands. Command deletion is permanent.

Type `/` in an active session to browse commands. Use ↑/↓ and Enter to select one,
or click it. Selection inserts `/name ` into the composer; add arguments and press
Enter again to send. Shift-Enter inserts a newline; Escape closes the menu. The
command palette also inserts presets into the selected session's composer. Any
existing draft text becomes arguments. Custom commands can be queued during a turn.

For example, create `analyze-ai-comments` with this body:

```text
Review the AI comments for {{task.title}}.
Task context: {{task.description}}
Focus on: {{args}}
```

Sending `/analyze-ai-comments correctness and missing tests` substitutes the task
fields and arguments. Supported placeholders are `{{args}}`, `{{task.title}}`, and
`{{task.description}}`. Repeated placeholders work; substitution is a single pass,
so placeholders inside arguments or task fields remain literal. If the body has no
`{{args}}`, arguments are appended after a blank line. Other placeholders are kept
as written. An empty expansion must be given arguments or an attachment before sending.

Expansion happens in the browser before sending or queuing. The transcript shows
the **expanded ordinary prompt**, and attachments are retained. These presets do
not invoke the agent SDK's slash commands. Unrecognized slash text keeps the
existing ordinary-message behavior.

## API and storage

The normal app middleware protects `/api/commands`, like other app routes.

- `GET /api/commands`: list app-wide definitions.
- `GET /api/commands?project_id=ID`: list app-wide and that project's definitions,
  including both when a name overlaps.
- `POST /api/commands`: create with `{ name, description?, body, project_id? }`.
  Omitted/null `project_id` means app-wide.
- `PATCH /api/commands`: replace editable fields with the same payload plus `id`.
- `DELETE /api/commands?id=ID`: hard delete.

Validation failures return 400, missing commands/projects 404, and duplicate names
within a scope 409. Names are limited to 80 characters, descriptions to 500, and
bodies to 100,000. Definitions live in the app SQLite database's `commands` table.
Open editors and composers refresh after local edits and on window focus.

Repository `.claude/commands/*.md` discovery is deferred; copy a prompt body into
the editor to use it as an Operator preset today.
