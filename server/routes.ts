import { Router } from 'express';
import { existsSync } from 'node:fs';
import { discoverRepos } from './discovery.ts';
import { reconcile, buildTerrariumView, stageOf, worktreeName } from './reconcile.ts';
import { newAvatarSeed, newSpecimenId, type SpecimenStore } from './state.ts';
import {
  branchExists,
  deleteBranch,
  getDefaultBranch,
  isDirty,
  isUsableWorktree,
  pruneRegistrations,
  pushBranch,
  removeWorktree,
  stageAll,
  unpushedCount,
} from './git.ts';
import { createMergeRequest, glabAvailable, MrTracker, refreshMergeRequests } from './gitlab.ts';
import { readSyncState, ResolveError, resolveRepo } from './resolve.ts';
import { findCodeCli, openInVsCode } from './vscode.ts';
import type { SproutManager } from './sprout.ts';
import type { TendManager, TendSession } from './tend.ts';
import { runDoctor } from './ralphex/doctor.ts';
import { findPlan } from './ralphex/plans.ts';
import { stepsOf, writeChangePlan } from './ralphex/revise.ts';
import { inspectChanges, type Changes } from './ralphex/changes.ts';
import { RESTART_EXIT_CODE, type Updater } from './update.ts';
import { appVersion } from './version.ts';
import type { Freshener } from './freshen.ts';
import type { TerrariumConfig } from './config.ts';
import type { PlanSummary, Pulse, Specimen, SpecimenView } from './types.ts';

const SPROUT_DISABLED =
  'Growing is switched off, so nothing was started. Set "sproutEnabled": true in terrarium.config.json to turn it back on.';

export function createRouter(
  config: TerrariumConfig,
  store: SpecimenStore,
  freshener: Freshener,
  updater: Updater,
  bootId: string,
  sprouts: SproutManager,
  tends: TendManager,
): Router {
  const router = Router();
  const mrs = new MrTracker();
  const scan = () =>
    discoverRepos(config.parentDir, config.excludeRepos, config.excludeWorktreePatterns);

  /** The Terrarium (FR-3): discovery + reconciliation on every load/refresh. */
  router.get('/terrarium', async (_req, res) => {
    const repos = await scan();
    const byRepo = reconcile(store, repos, config.excludeWorktreePatterns);
    const doctor = await runDoctor(config.ralphexCommand);
    const view = buildTerrariumView(
      repos,
      byRepo,
      store,
      (await findCodeCli(config.codeCommand)) !== null,
      (name) => freshener.last(name),
      (name, branch) => mrs.last(name, branch),
      (specimen) => planSummaryOf(config, specimen),
      (specimen) => pulseOf(tends.forSpecimen(specimen.id)),
    );
    res.json({ ...view, sproutEnabled: config.sproutEnabled, doctor });
  });

  /** Re-run the tool checks now, for the modal that lists what is missing. */
  router.get('/doctor', async (_req, res) => {
    res.json(await runDoctor(config.ralphexCommand, true));
  });

  /**
   * Bring every repo's default branch level with origin, and re-ask GitLab
   * which merge requests the specimen branches have. The UI calls this on
   * load (throttled by `autoSyncMinutes`) and with `force` behind the Refresh
   * button, then re-reads /terrarium — so the sync is never in the way of a
   * first paint.
   */
  router.post('/sync', async (req, res) => {
    const force = Boolean((req.body ?? {}).force);
    if (!force && !config.autoSync) return res.json({ repos: [], skipped: true });
    const repos = await scan();
    const opts = { force, maxAgeMs: config.autoSyncMinutes * 60_000 };
    const byRepo = reconcile(store, repos, config.excludeWorktreePatterns);
    const [results] = await Promise.all([
      freshener.syncAll(repos, opts),
      refreshMergeRequests(mrs, repos, byRepo, opts),
    ]);
    res.json({ repos: results, skipped: false });
  });

  /**
   * The state behind a repo's sync chip: how the default branch and origin
   * differ, who is holding the branch, and which backups already exist. Read
   * only — the dialog opens on this before offering to change anything.
   */
  router.get('/repos/:name/sync-state', async (req, res) => {
    const repo = (await scan()).find((r) => r.name === req.params.name);
    if (!repo) return res.status(404).json({ error: `Unknown repository: ${req.params.name}` });
    res.json(await readSyncState(repo, freshener));
  });

  /**
   * Act on that state. `fetch` is just a forced sync pass; `rebase` and `reset`
   * rewrite the default branch — always onto a backup ref, never over a dirty
   * worktree, and only because someone pressed the button.
   */
  router.post('/repos/:name/resolve', async (req, res) => {
    const repo = (await scan()).find((r) => r.name === req.params.name);
    if (!repo) return res.status(404).json({ error: `Unknown repository: ${req.params.name}` });
    const action = String((req.body ?? {}).action ?? '');

    if (action === 'fetch') {
      const sync = await freshener.sync(repo, { force: true });
      return res.json({
        sync,
        message: sync.problem ?? (sync.advancedBy > 0 ? `Fast-forwarded ${sync.advancedBy} commits.` : 'Already level with origin.'),
        backupRef: null,
        state: await readSyncState(repo, freshener),
      });
    }
    if (action !== 'rebase' && action !== 'reset') {
      return res.status(400).json({ error: `Unknown action: ${action || '(none)'}` });
    }

    try {
      const { message, backupRef } = await resolveRepo(repo, action, freshener);
      // Re-run the pass so the header chip reflects the new reality immediately.
      const sync = await freshener.sync(repo, { force: false, maxAgeMs: config.autoSyncMinutes * 60_000 });
      res.json({ sync, message, backupRef, state: await readSyncState(repo, freshener) });
    } catch (err) {
      const status = err instanceof ResolveError ? 409 : 500;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  router.get('/archive', (_req, res) => {
    const archived = store.specimens
      .filter((s) => s.archivedAt !== null)
      .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
      .map((s) => ({ ...s, name: worktreeName(s.worktreePath), stage: stageOf(s) }));
    res.json({ specimens: archived });
  });

  /** FR-6: manual checklist + notes; persists immediately. Plus the tuck toggle. */
  router.patch('/specimens/:id', (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const patch: Partial<Pick<Specimen, 'checklist' | 'notes' | 'minimized'>> = {};
    const { checklist, notes, minimized } = req.body ?? {};
    if (minimized !== undefined) patch.minimized = Boolean(minimized);
    if (checklist !== undefined) {
      patch.checklist = {
        sandbox: Boolean(checklist.sandbox),
        qa: Boolean(checklist.qa),
        production: Boolean(checklist.production),
      };
    }
    if (notes !== undefined) patch.notes = String(notes);
    const updated = store.update(specimen.id, patch);
    res.json(viewOf(updated));
  });

  /**
   * The plan ralphex is working in this worktree. Read fresh off disk every
   * time — ralphex ticks its checkboxes as each step lands, so the file is both
   * the design and the progress bar, and there is nothing worth caching.
   */
  router.get('/specimens/:id/plan', (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const doc = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
    // Finding it once is worth remembering: the next read starts from the
    // answer rather than the search.
    if (doc.file && doc.file !== specimen.planPath) store.update(specimen.id, { planPath: doc.file });
    res.json({ file: doc.file, markdown: doc.markdown, analysis: doc.analysis, dir: doc.dir });
  });

  /** What this specimen's branch carries, compared with the branch it was cut from. */
  router.get('/specimens/:id/changes', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const tend = tends.forSpecimen(specimen.id);
    if (tend) return res.json(await tend.refreshChanges());
    res.json(await inspectChanges(specimen.worktreePath, specimen.branch, repoPathOf(config, specimen)));
  });

  /**
   * Pre-prune inspection: the confirmation dialog must state dirt/unpushed work
   * (FR-7.3). Every probe is best-effort — a folder can outlive its git
   * registration, and "can't inspect it" is a fact to report, not a dead end.
   */
  router.get('/specimens/:id/prune-check', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const repoPath = repoPathOf(config, specimen);
    const present = existsSync(specimen.worktreePath);
    const usable = present ? await isUsableWorktree(specimen.worktreePath) : false;
    let dirty = false;
    let unpushed = 0;
    let hasBranch = false;
    let problem: string | null = null;

    if (present && usable) {
      try {
        dirty = await isDirty(specimen.worktreePath);
      } catch (err) {
        problem = `Could not read the worktree's status: ${(err as Error).message}`;
      }
    } else if (present) {
      problem = 'The folder is still on disk but git no longer recognises it as a worktree.';
    }
    if (repoPath) {
      hasBranch = await branchExists(repoPath, specimen.branch);
      if (hasBranch) unpushed = await unpushedCount(repoPath, specimen.branch);
    } else {
      problem ??= `Parent repository ${specimen.repo} is not on disk, so only the record can be archived.`;
    }

    res.json({
      present,
      usable,
      dirty,
      unpushedCount: unpushed,
      branch: specimen.branch,
      branchExists: hasBranch,
      repoFound: repoPath !== null,
      problem,
    });
  });

  /**
   * FR-7: prune. Removes the worktree if it still exists, deletes the local
   * branch if it still exists, then archives the record. Branch removal is not
   * optional — a worktree's branch has no life of its own once the worktree is
   * gone, and leaving it behind was only ever a way to accumulate dead refs.
   */
  router.post('/specimens/:id/prune', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    if (specimen.archivedAt) return res.status(409).json({ error: 'Specimen already archived' });
    const { force = false } = req.body ?? {};
    const repoPath = repoPathOf(config, specimen);
    let note: string | null = null;

    try {
      const present = existsSync(specimen.worktreePath);
      if (present && (await isUsableWorktree(specimen.worktreePath))) {
        if (!repoPath) return res.status(409).json({ error: 'Parent repository not found on disk' });
        await removeWorktree(repoPath, specimen.worktreePath, Boolean(force));
      } else if (present && repoPath) {
        // The folder outlived its git registration. Clear the stale entry and
        // archive the record; deleting someone's files is not Terrarium's job.
        await pruneRegistrations(repoPath);
        note = `git no longer owns ${specimen.worktreePath}, so the folder was left in place.`;
      }
      if (repoPath && (await branchExists(repoPath, specimen.branch))) {
        await deleteBranch(repoPath, specimen.branch);
      }
    } catch (err) {
      const message = (err as Error).message;
      const needsForce = /contains modified or untracked files|use --force/i.test(message);
      return res.status(409).json({ error: message, needsForce });
    }

    const updated = store.update(specimen.id, { archivedAt: new Date().toISOString() });
    res.json({ ...viewOf(updated), note });
  });

  /**
   * FR-5: open in VS Code — with the work staged first, so the editor opens on
   * the diff rather than on a folder. Going to look at what a run left is the
   * only reason this button exists.
   */
  router.post('/specimens/:id/open', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    if (!existsSync(specimen.worktreePath)) {
      return res.status(409).json({ error: 'Worktree no longer exists on disk' });
    }
    await stageAll(specimen.worktreePath);
    res.json(await openInVsCode(specimen.worktreePath, config.codeCommand));
  });

  router.post('/open-path', async (req, res) => {
    const { path } = req.body ?? {};
    if (typeof path !== 'string' || !existsSync(path)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }
    res.json(await openInVsCode(path, config.codeCommand));
  });

  // ---- The dashboard updating itself ---------------------------------------

  /** The last self-update check — cheap, no network. The UI polls this. */
  router.get('/update', (_req, res) => {
    res.json({ bootId, version: appVersion(config.appRoot), status: updater.status() });
  });

  /** Check right now. Rides the Refresh button alongside the repo sync. */
  router.post('/update/check', async (_req, res) => {
    res.json({ bootId, version: appVersion(config.appRoot), status: await updater.check() });
  });

  /**
   * Pull the update (strict fast-forward), reinstall/rebuild what changed,
   * then hand the process to the keeper (`main.ts`) for a restart. Under a
   * bare `node server/index.ts` there is no keeper, so the response says to
   * restart by hand instead of exiting into nothing.
   */
  router.post('/update/apply', async (_req, res) => {
    const supervised = process.env.TERRARIUM_SUPERVISED === '1';
    try {
      const result = await updater.apply();
      res.json({
        ok: true,
        restarting: supervised,
        pulled: result.pulled,
        message: supervised
          ? 'Repotted. The terrarium is restarting — the page reloads itself.'
          : 'Updated on disk. Stop Terrarium (Ctrl-C) and run `npm start` again to finish.',
      });
      // Long enough for the response to flush; short enough to feel immediate.
      if (supervised) setTimeout(() => process.exit(RESTART_EXIT_CODE), 500);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // ---- Sprout: the interview, and the seedling it earns ---------------------

  router.post('/sprout', async (req, res) => {
    const blocked = await growingBlocked();
    if (blocked) return res.status(503).json({ error: blocked });

    const { repo, description = '' } = req.body ?? {};
    if (!String(description).trim()) {
      return res.status(400).json({ error: 'Say what you want built — the interview starts from it.' });
    }
    const repos = await scan();
    const target = repos.find((r) => r.name === repo && !r.error);
    if (!target) return res.status(400).json({ error: `Unknown or unscannable repository: ${repo}` });

    // A new worktree must come off current code, so this fetch is not optional
    // and not throttled. A repo we cannot sync still sprouts — the developer is
    // told about it through the response instead.
    const sync = await freshener.sync(target, { force: true });
    try {
      const sprout = sprouts.create(target.name, target.path, String(description));
      res.json({ sessionId: sprout.id, sync });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/sprout/:id/events', (req, res) => {
    const sprout = sprouts.get(req.params.id);
    if (!sprout) return res.status(404).json({ error: 'Unknown session' });
    sprout.session.subscribe(res);
  });

  router.post('/sprout/:id/message', (req, res) => {
    const sprout = sprouts.get(req.params.id);
    if (!sprout) return res.status(404).json({ error: 'Unknown session' });
    const { text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Empty message' });
    try {
      sprout.session.say(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  router.post('/sprout/:id/answer', (req, res) => {
    const sprout = sprouts.get(req.params.id);
    if (!sprout) return res.status(404).json({ error: 'Unknown session' });
    if (!answerSession(sprout.session, req.body ?? {})) {
      return res.status(409).json({ error: 'No matching pending question' });
    }
    res.json({ ok: true });
  });

  /**
   * Potting: the plan becomes a worktree, and the worktree a tracked specimen.
   *
   * The interview does not have to have finished. Once it has written its plan
   * the seedling is real, and it may well still be offering to work that plan
   * where it stands — so potting winds it up rather than waiting for it, and
   * the work happens in the worktree the plan just earned.
   */
  router.post('/sprout/:id/finish', async (req, res) => {
    const sprout = sprouts.get(req.params.id);
    if (!sprout) return res.status(404).json({ error: 'Unknown session' });

    let grown;
    try {
      grown = await sprout.take();
    } catch (err) {
      return res.status(409).json({ error: (err as Error).message });
    }
    // The plan was still a draft, so taking it is what set ralphex writing the
    // file. There is nothing to grow until that lands; the page is watching the
    // same stream and comes back when it does.
    if (!grown) return res.json({ writing: true, specimens: [] });

    const repos = await scan();
    reconcile(store, repos, config.excludeWorktreePatterns); // every on-disk worktree gets a record
    sprout.session.close();

    let record = store.specimens.find((s) => s.worktreePath === grown.worktreePath && s.archivedAt === null);
    if (record) {
      record = store.update(record.id, { origin: 'sprouted', planPath: grown.planPath, branch: grown.branch });
    } else {
      const fresh: Specimen = {
        id: newSpecimenId(),
        repo: sprout.repo,
        branch: grown.branch,
        worktreePath: grown.worktreePath,
        createdAt: new Date().toISOString(),
        avatarSeed: newAvatarSeed(),
        checklist: { sandbox: false, qa: false, production: false },
        notes: '',
        origin: 'sprouted',
        archivedAt: null,
        minimized: false,
        planPath: grown.planPath,
        lastRun: null,
      };
      store.add(fresh);
      record = fresh;
    }
    res.json({ specimens: [viewOf(record)] });
  });

  router.post('/sprout/:id/abort', async (req, res) => {
    const sprout = sprouts.get(req.params.id);
    if (!sprout) return res.status(404).json({ error: 'Unknown session' });
    // Composting deletes what this session grew; anything it cannot remove
    // still shows up as `discovered` on the next reconciliation.
    const { removed, failed } = await sprout.compost();
    res.json({ ok: true, removed, failed });
  });

  // ---- The tending bench: ralphex working the plan --------------------------

  /** Everything the bench opens on: the plan, the branch, and any live run. */
  router.get('/specimens/:id/bench', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const doc = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
    if (doc.file && doc.file !== specimen.planPath) store.update(specimen.id, { planPath: doc.file });
    const tend = tends.forSpecimen(specimen.id);
    const doctor = await runDoctor(config.ralphexCommand);
    res.json({
      specimen: viewOf(store.get(specimen.id)!),
      plan: { file: doc.file, markdown: doc.markdown, analysis: doc.analysis, dir: doc.dir },
      sessionId: tend ? tend.id : null,
      changes: tend?.changes ?? null,
      sproutEnabled: config.sproutEnabled,
      doctor,
    });
  });

  /** Set ralphex going on this specimen's plan, in this specimen's worktree. */
  router.post('/specimens/:id/grow', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    if (!existsSync(specimen.worktreePath)) {
      return res.status(409).json({ error: 'This worktree is gone, so there is nothing to work in.' });
    }
    const blocked = await growingBlocked();
    if (blocked) return res.status(503).json({ error: blocked });

    // Nothing is read off the request. Growing is the whole loop, and how it is
    // put together — the models, the cap on its passes — is decided here.
    try {
      const tend = tends.create(specimen, repoPathOf(config, specimen));
      res.json({ sessionId: tend.id });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  /**
   * Say what is wrong with finished work, and set the loop on it.
   *
   * Not the interview again. The interview's question is what to build, and
   * that one is answered — this is somebody reading built work and naming what
   * is off about it, which is a plan of its own and a short one. Terrarium
   * writes it: a summary of what is already here so the run does not start the
   * project over, then the note itself, one step per line.
   *
   * A fresh, small plan is also a fresh, small context. Appending boxes to the
   * finished plan would make every pass of every future change pay again for
   * the whole original design.
   */
  router.post('/specimens/:id/revise', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    if (!existsSync(specimen.worktreePath)) {
      return res.status(409).json({ error: 'This worktree is gone, so there is nothing to work in.' });
    }
    const note = String((req.body ?? {}).note ?? '').trim();
    if (!note) return res.status(400).json({ error: 'Say what you want changed.' });
    const blocked = await growingBlocked();
    if (blocked) return res.status(503).json({ error: blocked });

    const done = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
    const changes = await inspectChanges(specimen.worktreePath, specimen.branch, repoPathOf(config, specimen));

    let planPath: string;
    try {
      planPath = await writeChangePlan(
        specimen.worktreePath,
        config.plansDir,
        {
          title: done.analysis?.title ?? null,
          built: done.markdown ? stepsOf(done.markdown) : [],
          branch: specimen.branch,
          commits: changes.commitCount ?? null,
          files: changes.fileCount ?? null,
        },
        note,
      );
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    // The bench is now looking at a different plan, so the record follows it.
    const updated = store.update(specimen.id, { planPath });
    try {
      const tend = tends.create(updated, repoPathOf(config, updated));
      res.json({ sessionId: tend.id, planPath, specimen: viewOf(store.get(specimen.id)!) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  /** What opening a merge request would do, before anybody presses anything. */
  router.get('/specimens/:id/merge-request/check', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    res.json(await mergeRequestPlan(specimen));
  });

  /**
   * Push the branch and open a merge request for it.
   *
   * The only thing in the Terrarium that leaves the machine, and the only git
   * write that anyone else can see. It happens once, on this button, with the
   * developer looking at exactly what it is about to do — never on the way to
   * something else and never on a timer.
   */
  router.post('/specimens/:id/merge-request', async (req, res) => {
    const specimen = store.get(req.params.id);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    const plan = await mergeRequestPlan(specimen);
    if (plan.blocked) return res.status(409).json({ error: plan.blocked });

    const repoPath = repoPathOf(config, specimen);
    if (!repoPath) return res.status(409).json({ error: 'This specimen has no repository to push to.' });

    try {
      await pushBranch(specimen.worktreePath, specimen.branch);
    } catch (err) {
      return res.status(502).json({ error: `The branch would not push: ${trimGit((err as Error).message)}` });
    }
    try {
      const { url } = await createMergeRequest(repoPath, {
        source: specimen.branch,
        target: plan.target!,
        title: plan.title,
        description: plan.description,
      });
      // The chip on the card comes from the same lookup as everything else, so
      // it only knows about this once it is asked again.
      await mrs.lookup(specimen.repo, repoPath, specimen.branch, { force: true }).catch(() => null);
      res.json({ ok: true, url, pushed: true, specimen: viewOf(store.get(specimen.id)!) });
    } catch (err) {
      // The push happened. Saying so is the difference between "try again" and
      // "the branch is up there, open the MR yourself".
      res.status(502).json({ error: (err as Error).message, pushed: true });
    }
  });

  router.get('/bench/:id/events', (req, res) => {
    const tend = tends.get(req.params.id);
    if (!tend) return res.status(404).json({ error: 'Unknown session' });
    tend.session.subscribe(res);
  });

  router.post('/bench/:id/answer', (req, res) => {
    const tend = tends.get(req.params.id);
    if (!tend) return res.status(404).json({ error: 'Unknown session' });
    if (!answerSession(tend.session, req.body ?? {})) {
      return res.status(409).json({ error: 'No matching pending question' });
    }
    res.json({ ok: true });
  });

  router.post('/bench/:id/message', (req, res) => {
    const tend = tends.get(req.params.id);
    if (!tend) return res.status(404).json({ error: 'Unknown session' });
    const { text } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Empty message' });
    try {
      tend.session.say(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  /** Stop the run. SIGINT first, so ralphex gets to finish the commit it is on. */
  router.post('/bench/:id/stop', (req, res) => {
    const tend = tends.get(req.params.id);
    if (!tend) return res.status(404).json({ error: 'Unknown session' });
    tend.session.cancel();
    res.json({ ok: true });
  });

  /**
   * The run is over and the developer has read it. Record what it came to on
   * the specimen, so the card still says so after a restart.
   */
  router.post('/bench/:id/settle', async (req, res) => {
    const tend = tends.get(req.params.id);
    if (!tend) return res.status(404).json({ error: 'Unknown session' });
    const specimen = store.get(tend.specimenId);
    if (!specimen) return res.status(404).json({ error: 'Unknown specimen' });
    if (tend.session.live) return res.json({ specimen: viewOf(specimen) });

    // Read, so the card can stop asking to be looked at.
    tend.acknowledged = true;
    const analysis = tend.plan?.analysis ?? null;
    const updated = store.update(specimen.id, {
      planPath: tend.planPath ?? specimen.planPath,
      lastRun: {
        at: tend.session.endedAt ?? new Date().toISOString(),
        mode: tend.mode,
        status: tend.session.status,
        tokens: tend.session.usage?.available ? tend.session.usage.totals.total : null,
        cost: tend.session.usage?.available ? tend.session.usage.totals.cost : null,
        steps: analysis ? analysis.progress.checkboxes : null,
      },
    });
    res.json({ specimen: viewOf(updated) });
  });

  /**
   * A record as the UI wants it.
   *
   * Every field the dashboard shows is filled in, not just the ones this route
   * happened to change: the browser merges what comes back over the card it
   * already has, so a half-filled view would blank the plan line the moment
   * somebody ticked a checkbox.
   */
  function viewOf(record: Specimen): SpecimenView {
    const tend = tends.forSpecimen(record.id);
    return {
      ...record,
      name: worktreeName(record.worktreePath),
      present: existsSync(record.worktreePath),
      head: null,
      stage: stageOf(record),
      mr: mrs.last(record.repo, record.branch),
      plan: planSummaryOf(config, record),
      growing: tend?.session.live === true,
      pulse: pulseOf(tend),
    };
  }

  /**
   * Everything the merge-request dialog needs, and everything the route that
   * actually does it checks — one function, so the screen can never offer a
   * button whose action would refuse for a reason it did not mention.
   *
   * The title is the plan's, because the plan's title is the interview's and
   * naming the change was its job. The body is the overview it wrote and the
   * steps it worked to, which is the closest thing to a description of the
   * change that exists without anybody writing one.
   */
  async function mergeRequestPlan(specimen: Specimen) {
    const repoPath = repoPathOf(config, specimen);
    const doc = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
    const present = existsSync(specimen.worktreePath);
    const changes: Changes = present
      ? await inspectChanges(specimen.worktreePath, specimen.branch, repoPath)
      : { available: false, reason: 'This worktree is gone.' };
    const target = repoPath ? await getDefaultBranch(repoPath) : null;
    const glab = await glabAvailable();
    const open = mrs.last(specimen.repo, specimen.branch);
    const steps = doc.analysis?.tasks.map((task) => task.description.trim()).filter(Boolean) ?? [];
    const title = doc.analysis?.title?.trim() || specimen.branch;
    const body = [doc.analysis?.overview?.trim() || '', steps.length ? 'Steps worked:' : '', ...steps.map((s) => `- ${s}`)]
      .filter(Boolean)
      .join('\n\n');

    let blocked: string | null = null;
    if (!present) blocked = 'This worktree is gone, so there is nothing to push.';
    else if (!repoPath) blocked = 'This specimen has no repository to push to.';
    else if (!glab) blocked = 'glab is not installed, so nothing here can open a merge request.';
    else if (!target) blocked = 'This repository has no default branch to merge into.';
    else if (!changes.available) blocked = changes.reason ?? 'Nothing has landed on this branch yet.';
    else if (!changes.commitCount) blocked = 'Nothing is committed on this branch, so there is nothing to merge.';
    else if (open && open.state === 'opened') blocked = `Merge request !${open.iid} is already open for this branch.`;

    return {
      branch: specimen.branch,
      target,
      title,
      description: body,
      commits: changes.commitCount ?? 0,
      files: changes.fileCount ?? 0,
      uncommitted: changes.uncommitted ?? 0,
      glab,
      existing: open,
      blocked,
    };
  }

  /**
   * What the card's glow is saying, or null for a card with nothing to say.
   *
   * Three states and no more: it is working, it is stopped and waiting on you,
   * or it stopped badly and nobody has looked yet. Looking is what clears the
   * last one — the bench writes the outcome onto the specimen when it sees the
   * run end, and that is the developer having seen it.
   */
  function pulseOf(tend: TendSession | undefined): Pulse {
    if (!tend) return null;
    if (tend.session.status === 'asking') return 'waiting';
    if (tend.session.live) return 'working';
    if (tend.session.status === 'failed' && !tend.acknowledged) return 'trouble';
    return null;
  }

  /**
   * git's own words, without the invocation it prefixes them with. What the
   * remote refused is worth reading; the command line Terrarium built to ask
   * is exactly what this screen never shows.
   */
  function trimGit(message: string): string {
    return String(message)
      .split('\n')
      .filter((line) => line.trim() && !/^Command failed:/.test(line.trim()))
      .join(' ')
      .trim()
      .slice(0, 400);
  }

  /** One sentence for why nothing can be grown right now, or null. */
  async function growingBlocked(): Promise<string | null> {
    if (!config.sproutEnabled) return SPROUT_DISABLED;
    const doctor = await runDoctor(config.ralphexCommand);
    if (doctor.ready) return null;
    return `Not installed: ${doctor.missingRequired.join(' and ')}. Everything else in the Terrarium still works.`;
  }

  return router;
}

function repoPathOf(config: TerrariumConfig, specimen: Specimen): string | null {
  const path = `${config.parentDir}/${specimen.repo}`;
  return existsSync(`${path}/.git`) ? path : null;
}

/**
 * The plan, boiled down to what a card shows: what the work is called, and how
 * many of its steps ralphex has ticked.
 */
function planSummaryOf(config: TerrariumConfig, specimen: Specimen): PlanSummary | null {
  const doc = findPlan(specimen.worktreePath, config.plansDir, specimen.branch, specimen.planPath);
  if (!doc.file || !doc.analysis) return null;
  const { checkboxes, percent, complete } = doc.analysis.progress;
  return {
    file: doc.file,
    title: doc.analysis.title,
    done: checkboxes.done,
    total: checkboxes.total,
    percent,
    complete,
  };
}

/**
 * Hand a question card's answer to the session. The card sends what it was
 * given — a picked label, a typed sentence, or both — and the session works out
 * what the picker underneath wants to read.
 */
function answerSession(session: { answer: (requestId: string, value: string | string[]) => boolean }, body: Record<string, unknown>): boolean {
  const requestId = String(body.requestId ?? '');
  const answers = (body.answers ?? {}) as Record<string, string | string[]>;
  const response = typeof body.response === 'string' ? body.response.trim() : '';
  const picked = Object.values(answers).flat().filter(Boolean) as string[];
  const value = response ? [...picked, response] : picked;
  return session.answer(requestId, value);
}
