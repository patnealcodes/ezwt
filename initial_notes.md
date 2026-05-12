Draft Workflow
Use a flat global root:
~/repos/repository-name                         # primary clone
~/worktrees/repository-name_JIRA-1234-header-nav # worktree
~/worktrees/api_JIRA-456-fix-auth            # worktree
Naming
Format:
<repo-name>_<ticket-or-feature-slug>
Examples:
repository-name_JIRA-1234-header-nav
repository-name_fix-homepage-cache
Branch can stay normal Git-style:
JIRA-1234-header-nav
fix/homepage-cache
Path names avoid slashes; branch names do not need to.
Manual Create Flow
From the primary clone:
repo="$(basename "$(git rev-parse --show-toplevel)")"
slug="JIRA-1234-header-nav"
path="$HOME/worktrees/${repo}_${slug}"
git fetch
git worktree add -b "$slug" "$path" origin/main
If the branch already exists:
git worktree add "$HOME/worktrees/${repo}_${slug}" "$slug"
Shared .env Pattern
Use an explicit per-repo env store:
~/.config/worktrees/env/repository-name/.env
~/.config/worktrees/env/repository-name/.env.local
~/.config/worktrees/env/repository-name/.env.development
Then symlink only allowlisted files into each worktree:
ln -s "$HOME/.config/worktrees/env/repository-name/.env" "$path/.env"
ln -s "$HOME/.config/worktrees/env/repository-name/.env.local" "$path/.env.local"
Rule: never auto-link every .env*; only link known safe filenames per repo.
Docker Pattern
Set a per-worktree Compose project name:
export COMPOSE_PROJECT_NAME="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')"
docker compose up
This isolates Compose containers, networks, and default volumes.
Important limitation: this does not solve host port conflicts. If two worktrees both expose 3000:3000, only one can run at a time unless you add port overrides later.
Recommended Manual Convention
Add this to each worktree when Docker is needed:
.env.worktree
Example:
COMPOSE_PROJECT_NAME=repository-name-jira-1234-header-nav
Then run:
set -a
. ./.env.worktree
set +a
docker compose up
Cleanup
When done:
git worktree remove "$HOME/worktrees/repository-name_JIRA-1234-header-nav"
git branch -d JIRA-1234-header-nav
Use -D only when you intentionally want to discard an unmerged branch.
Open Issue
Per-worktree Docker project names are the right baseline, but concurrent app runs will still need either port offsets or app-level dynamic ports.
