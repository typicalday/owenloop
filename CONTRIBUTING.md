# Contributing to owenloop

Thanks for your interest in owenloop. Before your first pull request can be merged,
there's one required step: signing our Contributor License Agreement.

## Contributor License Agreement (required)

owenloop is owned by **Typical Day LLC**. The project is released under the
[GNU AGPLv3](LICENSE), and a separate commercial license is offered to
organizations that don't want AGPLv3 obligations. To keep this dual-licensing
possible — and to keep ownership of the codebase clear and in one place — Typical
Day must be the sole owner of the project's copyright.

So we ask every contributor to sign a **Contributor License Agreement (CLA)** that
**assigns copyright** in your contributions to Typical Day LLC. In plain terms:

- You **transfer ownership** of the code you contribute to Typical Day LLC.
- You get a **license back** to keep using your own contributions for anything you
  like.
- Typical Day can license and **relicense** owenloop — AGPLv3, commercial, or
  otherwise — without needing to track down every contributor.

This is a deliberate choice. If assigning copyright isn't something you're willing
to do, that's completely fine — but we won't be able to merge the contribution.

- **Individuals:** [.github/CLA.md](.github/CLA.md)
- **Contributing on behalf of an employer:** [.github/CORPORATE-CLA.md](.github/CORPORATE-CLA.md)

### How signing works

When you open a pull request, an automated check (CLA Assistant) posts a comment.
If you haven't signed yet, it asks you to reply on the PR with:

> I have read the CLA Document and I hereby sign the CLA

That records your signature (keyed to your GitHub account) so you only ever do it
once, across all your future PRs. The check then turns green and the PR can be
merged. Corporate contributors should additionally have an authorized signatory
complete [the Corporate CLA](.github/CORPORATE-CLA.md) and send it to us.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Make your change. Keep it focused — one logical change per PR.
3. Run the checks locally before pushing:
   ```bash
   npm ci
   bash .dev/checks.sh
   ```
4. Open a pull request against `main`. CI runs on Node 22 and 24.
5. Sign the CLA when prompted (see above).

## Reporting bugs and proposing features

Open an issue. For a security vulnerability, please **do not** open a public
issue — contact Typical Day directly so it can be handled responsibly.
