# Contributor License Agreements

| Form | File | Who signs | How |
| --- | --- | --- | --- |
| Individual CLA v1 | [individual-v1.md](./individual-v1.md) | A person contributing for themselves | Online, through CLA Assistant on their first pull request |
| Corporate CLA v1 | [corporate-v1.md](./corporate-v1.md) | A company whose staff contribute | Offline, returned to legal@atumlabs.xyz and kept in Atum's legal records |

The text of each form is the version Atum's counsel provided. Do not edit it. A
change to either form is a new version: add `individual-v2.md` or
`corporate-v2.md`, keep v1 as the record of what earlier signers agreed to, and
update this table.

## Maintainer setup

The CLA check runs on [CLA Assistant](https://cla-assistant.io), a GitHub App.
Nothing in this repository runs it, and its settings live in CLA Assistant and
in branch protection.

1. Create a secret gist owned by a shared Atum service user account, not an
   individual employee's account. GitHub organizations cannot own gists. The
   same account signs in to CLA Assistant to link and manage it. Add two files:
   - the CLA text, byte-identical to [individual-v1.md](./individual-v1.md)
   - a file named `metadata` with the content below
2. Finalize both gist files before linking. Every gist edit, including
   whitespace, is a new revision and asks every earlier signer to sign again. A
   gist edit therefore needs a new `individual-vN.md` and a new row in the table
   above.
3. In CLA Assistant, link this repository to the gist.
4. Fill in the allowlist:
   - `*[bot]`
   - the GitHub logins of Atum staff and contractors whose IP assignment to Atum
     is confirmed
   - the GitHub IDs in Schedule A of each signed Corporate CLA

   Update it when staff or contractors join or leave, and when a company sends
   a Schedule A update, including removals.
5. Only after the allowlist is filled in, add the `license/cla` status check as
   required in this repository's branch protection.

`metadata` file for the gist:

```json
{
  "name": {
    "title": "Full legal name",
    "type": "string",
    "githubKey": "name",
    "required": true
  },
  "email": {
    "title": "Email",
    "type": "string",
    "githubKey": "email",
    "required": true
  },
  "address": {
    "title": "Residence address",
    "type": "string",
    "required": true
  },
  "country": {
    "title": "Country",
    "type": "string",
    "required": true
  },
  "employer": {
    "title": "Employer (if any)",
    "type": "string",
    "required": false
  }
}
```

CLA Assistant records the GitHub login, the date and the gist revision with
these fields for every signature.

## Signer data

Signer names, addresses and emails are stored by CLA Assistant, and only its
admins can export them. Signed Corporate CLAs and their Schedule A rosters stay
in Atum's legal records.

None of this goes into this repository: no signed forms, rosters, allowlists,
exports or tokens.
