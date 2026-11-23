import { describe, expect, it } from 'vitest';
import type { PodApi } from '@shared/ipc';
import { fakeApi, FakeApiStore } from './fake-api';

describe('fakeApi', () => {
  it('satisfies PodApi interface type-level', () => {
    // Type-level assertion
    const _api: PodApi = fakeApi satisfies PodApi;
    expect(_api).toBeDefined();
    expect(typeof fakeApi.app.getInfo).toBe('function');
    expect(typeof fakeApi.provider.getStatus).toBe('function');
    expect(typeof fakeApi.provider.testConnection).toBe('function');
    expect(typeof fakeApi.images.pick).toBe('function');
    expect(typeof fakeApi.images.stageFile).toBe('function');
    expect(typeof fakeApi.catalog.listCategories).toBe('function');
    expect(typeof fakeApi.prompts.listTemplates).toBe('function');
    expect(typeof fakeApi.prompts.getTemplate).toBe('function');
    expect(typeof fakeApi.prompts.preview).toBe('function');
    expect(typeof fakeApi.prompts.validate).toBe('function');
    expect(typeof fakeApi.prompts.saveVersion).toBe('function');
    expect(typeof fakeApi.prompts.setDefault).toBe('function');
    expect(typeof fakeApi.jobs.create).toBe('function');
    expect(typeof fakeApi.jobs.list).toBe('function');
    expect(typeof fakeApi.jobs.get).toBe('function');
    expect(typeof fakeApi.jobs.retry).toBe('function');
    expect(typeof fakeApi.jobs.regenerate).toBe('function');
    expect(typeof fakeApi.jobs.resolveAmbiguous).toBe('function');
    expect(typeof fakeApi.jobs.retryDownload).toBe('function');
    expect(typeof fakeApi.jobs.cancel).toBe('function');
    expect(typeof fakeApi.jobs.setReview).toBe('function');
    expect(typeof fakeApi.jobs.onUpdated).toBe('function');
    expect(typeof fakeApi.library.openFolder).toBe('function');
    expect(typeof fakeApi.library.copyPath).toBe('function');
    expect(typeof fakeApi.admin.getSettings).toBe('function');
    expect(typeof fakeApi.admin.updateSettings).toBe('function');
    expect(typeof fakeApi.admin.setBridgeApiKey).toBe('function');
    expect(typeof fakeApi.admin.clearBridgeApiKey).toBe('function');
    expect(typeof fakeApi.admin.diagnosticsPreview).toBe('function');
    expect(typeof fakeApi.admin.diagnosticsExport).toBe('function');
    expect(typeof fakeApi.admin.runCleanup).toBe('function');
  });

  it('smokes tests app, provider, prompts, jobs, and admin in-memory operations', async () => {
    const store = new FakeApiStore();
    const api = store.getApi();

    // app
    const appInfo = await api.app.getInfo();
    expect(appInfo.ok).toBe(true);
    if (appInfo.ok) {
      expect(appInfo.data.version).toBe('0.1.0');
    }

    // provider
    const providerStatus = await api.provider.getStatus();
    expect(providerStatus.ok).toBe(true);
    if (providerStatus.ok) {
      expect(providerStatus.data.state).toBe('ready');
    }

    // catalog
    const cats = await api.catalog.listCategories();
    expect(cats.ok).toBe(true);
    if (cats.ok) {
      expect(cats.data.length).toBeGreaterThan(0);
    }

    // prompts
    const templates = await api.prompts.listTemplates();
    expect(templates.ok).toBe(true);
    if (templates.ok) {
      expect(templates.data.length).toBeGreaterThan(0);
      const first = templates.data[0];
      if (first) {
        const preview = await api.prompts.preview({
          templateId: first.id,
          sku: 'TS-001',
          categoryId: 't-shirt',
        });
        expect(preview.ok).toBe(true);
        if (preview.ok) {
          expect(preview.data.text).toContain('TS-001');
        }
      }
    }

    // jobs create & list
    const createRes = await api.jobs.create({
      sku: 'TS-001',
      categoryId: 't-shirt',
      templateId: 'product-review',
      templateVersion: 'v2',
      sourceToken: 'token-123',
      clientRequestId: '00000000-0000-0000-0000-000000000001',
    });
    expect(createRes.ok).toBe(true);
    if (createRes.ok) {
      expect(createRes.data.job.skuSnapshot).toBe('TS-001');
      expect(createRes.data.job.idempotencyKey).toBe('00000000-0000-0000-0000-000000000001');

      // Duplicate call with same clientRequestId returns identical job
      const dupRes = await api.jobs.create({
        sku: 'TS-001',
        categoryId: 't-shirt',
        templateId: 'product-review',
        templateVersion: 'v2',
        sourceToken: 'token-123',
        clientRequestId: '00000000-0000-0000-0000-000000000001',
      });
      expect(dupRes.ok).toBe(true);
      if (dupRes.ok) {
        expect(dupRes.data.job.id).toBe(createRes.data.job.id);
      }
    }

    // admin
    const settings = await api.admin.getSettings();
    expect(settings.ok).toBe(true);
    const diag = await api.admin.diagnosticsPreview();
    expect(diag.ok).toBe(true);

    store.clearTimers();
  });
});
