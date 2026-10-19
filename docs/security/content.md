# Public website content: security review (CMS-1)

| Threat                   | Control                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored XSS               | No HTML anywhere:<br>• blocks, rich text and links are strict Zod schemas; unknown types and fields are refused (`.strict()`);<br>• text is rendered as React text (WEB-1);<br>• markup typed by an editor stays literal characters.                           |
| Script or phishing links | Typed link targets only. External URLs must be absolute HTTPS, without credentials. `javascript:`, `data:`, `mailto:` and `http:` are refused. Application links are resolved from the site settings.                                                          |
| Oversized content        | Every string and list is bounded (for example, 40 blocks per page). A document is a JSON object of at most 256 KiB (PostgreSQL CHECK).                                                                                                                         |
| Path abuse               | Public paths are lowercase segments of letters, digits and dashes (at most 4 levels, 120 characters). Reserved routes cannot be taken: `/sitemap`, `/robots`, `/apercu`, `/api`, `/media`, social images and the icon. API and CHECK constraint agree.         |
| Draft disclosure         | Public endpoints read only the `PUBLISHED` revision of non-archived pages. Drafts, history and authors are behind `ops.access` and `content.read`.                                                                                                             |
| Privilege separation     | `content.read` and `content.manage` are separate from every operational permission. `seo.manage` is needed to change indexing or search metadata, and new pages start non-indexable. The RBAC matrix and the per-role HTTP checks prove it.                    |
| CSRF                     | Every mutation requires a STAFF session and its CSRF token.                                                                                                                                                                                                    |
| Lost updates             | Each mutation locks the entry row; `expectedDraftUpdatedAt` makes a stale decision fail with a 409. A forced-overlap test proves that two simultaneous publications give exactly one success.                                                                  |
| History tampering        | PostgreSQL triggers make `PUBLISHED` and `SUPERSEDED` revisions immutable, refuse the deletion of entries and of non-draft revisions, refuse truncation, and keep revision numbers monotonic and never reused. Publication times come from the database clock. |
| Audit evasion            | Every mutation is audited in its transaction (rollback on audit failure), with document fingerprints but without document copies.                                                                                                                              |
| Cache poisoning          | Public responses depend only on the query parameter `path`, validated before use. `Cache-Control: public, max-age=60`; there are no personalized public responses.                                                                                             |

## Privacy

Content documents hold no personal data:

- legal and contact settings describe the company;
- missing owner information stays `null`;
- author and publisher identities (STAFF e-mails) are visible only to
  `content.read` holders and in the audit trail.
