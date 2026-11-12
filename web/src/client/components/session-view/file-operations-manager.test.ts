// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/image-downscale.js', () => ({
  prepareImageForUpload: vi.fn(async (file: File) =>
    file.type.startsWith('image/')
      ? new File(['small'], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })
      : file
  ),
}));

vi.mock('../../services/auth-client.js', () => ({
  authClient: { getAuthHeader: () => ({ Authorization: 'Bearer t' }) },
}));

import {
  type FileOperationsCallbacks,
  FileOperationsManager,
  uploadWithProgress,
} from './file-operations-manager';

/** Fake XMLHttpRequest: records sends; the test decides when and how each one finishes. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  responseText = '';
  url = '';
  headers: Record<string, string> = {};
  sent: File | null = null;
  private listeners: Record<string, (e?: unknown) => void> = {};
  private uploadListeners: Record<string, (e: unknown) => void> = {};
  upload = {
    addEventListener: (type: string, cb: (e: unknown) => void) => {
      this.uploadListeners[type] = cb;
    },
  };
  constructor() {
    FakeXHR.instances.push(this);
  }
  addEventListener(type: string, cb: (e?: unknown) => void) {
    this.listeners[type] = cb;
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send(form: FormData) {
    this.sent = form.get('file') as File;
  }
  progress(loaded: number, total: number) {
    this.uploadListeners.progress?.({ lengthComputable: true, loaded, total });
  }
  succeed(path: string) {
    this.status = 200;
    this.responseText = JSON.stringify({ success: true, path, filename: 'x', size: 1 });
    this.listeners.load?.();
  }
  fail() {
    this.listeners.error?.();
  }
  aborted = false;
  abort() {
    this.aborted = true;
    this.listeners.abort?.();
  }
}

async function nextXhr(index: number): Promise<FakeXHR> {
  return vi.waitFor(() => {
    const xhr = FakeXHR.instances[index];
    if (!xhr?.sent) throw new Error('not sent yet');
    return xhr;
  });
}

function makeManager() {
  const sendInputText = vi.fn(async (_text: string) => {});
  const callbacks: FileOperationsCallbacks = {
    getSession: () => ({ id: 's1' }) as never,
    getInputManager: () => ({ sendInputText }) as never,
    querySelector: () => null,
    setIsDragOver: vi.fn(),
    setShowFileBrowser: vi.fn(),
    setShowImagePicker: vi.fn(),
    getIsMobile: () => true,
    getShowFileBrowser: () => false,
    getShowImagePicker: () => false,
    dispatchEvent: () => true,
    requestUpdate: vi.fn(),
  };
  const manager = new FileOperationsManager();
  manager.setCallbacks(callbacks);
  return { manager, sendInputText };
}

describe('FileOperationsManager image attachments', () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('downscales a picked photo, uploads it and types its path', async () => {
    const { manager, sendInputText } = makeManager();
    manager.selectImage();
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toBe('image/*,video/*');

    const photo = new File([new Uint8Array(4096)], 'IMG_0001.HEIC', { type: 'image/heic' });
    const done = manager.handleImagesPicked([photo]);

    const xhr = await nextXhr(0);
    expect(xhr.url).toBe('/api/files/upload');
    expect(xhr.headers.Authorization).toBe('Bearer t');
    expect(xhr.sent?.name).toBe('IMG_0001.jpg');
    expect(xhr.sent?.type).toBe('image/jpeg');

    xhr.succeed('/up/a.jpg');
    await done;
    expect(sendInputText).toHaveBeenCalledWith('/up/a.jpg');
  });

  it('reports upload progress in the status pill', async () => {
    const { manager } = makeManager();
    const done = manager.handleImagesPicked([new File(['x'], 'a.png', { type: 'image/png' })]);

    const xhr = await nextXhr(0);
    xhr.progress(42, 100);
    const status = document.querySelector('.ut-upload-status') as HTMLElement;
    expect(status.textContent).toContain('42%');
    const bar = status.querySelector('.ut-upload-status-bar') as HTMLElement;
    expect(bar.style.width).toBe('42%');

    xhr.succeed('/up/a.jpg');
    await done;
    expect(document.querySelector('.ut-upload-status')).toBeNull();
  });
});

describe('FileOperationsManager multiple images', () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const photos = () =>
    ['a.jpg', 'b c.jpg', 'd.jpg'].map((n) => new File(['x'], n, { type: 'image/jpeg' }));

  it('leaving the session cancels the upload and types nothing into it', async () => {
    const { manager, sendInputText } = makeManager();
    const done = manager.handleImagesPicked(photos().slice(0, 1));
    const xhr = await nextXhr(0);
    xhr.progress(30, 100);

    manager.removeEventListeners(document.createElement('div'));
    await done;

    expect(xhr.aborted).toBe(true);
    expect(sendInputText).not.toHaveBeenCalled();
    expect(document.querySelector('.ut-upload-status')).toBeNull();
  });

  it('picks any file from the device with no accept filter (a PDF is not greyed out)', () => {
    const { manager } = makeManager();
    manager.selectFiles();
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.hasAttribute('accept')).toBe(false);
    expect(input.multiple).toBe(true);
  });

  it('lets the picker select several photos', () => {
    const { manager } = makeManager();
    manager.selectImage();
    expect((document.body.querySelector('input[type="file"]') as HTMLInputElement).multiple).toBe(
      true
    );
  });

  it('uploads them one at a time and types all paths at once, space-separated', async () => {
    const { manager, sendInputText } = makeManager();
    const done = manager.handleImagesPicked(photos());

    (await nextXhr(0)).progress(50, 100);
    expect(FakeXHR.instances).toHaveLength(1); // sequential, not parallel
    expect(document.querySelector('.ut-upload-status')?.textContent).toContain('1 of 3');
    FakeXHR.instances[0].succeed('/up/a.jpg');
    (await nextXhr(1)).succeed('/up/b c.jpg');
    (await nextXhr(2)).succeed('/up/d.jpg');
    await done;

    expect(sendInputText).toHaveBeenCalledTimes(1);
    expect(sendInputText).toHaveBeenCalledWith("/up/a.jpg '/up/b c.jpg' /up/d.jpg");
  });

  it('types what succeeded, and Retry resumes from the failed photo', async () => {
    const { manager, sendInputText } = makeManager();
    const done = manager.handleImagesPicked(photos());

    (await nextXhr(0)).succeed('/up/a.jpg');
    (await nextXhr(1)).fail();
    await done;
    expect(sendInputText).toHaveBeenCalledWith('/up/a.jpg');

    const retry = document.querySelector(
      '.ut-upload-status button[data-action="retry"]'
    ) as HTMLButtonElement;
    retry.click();

    const again = await nextXhr(2);
    expect(again.sent?.name).toBe('b c.jpg');
    again.succeed('/up/b c.jpg');
    (await nextXhr(3)).succeed('/up/d.jpg');

    await vi.waitFor(() =>
      expect(sendInputText).toHaveBeenLastCalledWith(" '/up/b c.jpg' /up/d.jpg")
    );
    expect(document.querySelector('.ut-upload-status')).toBeNull();
  });
});

describe('uploadWithProgress', () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects with the server error message', async () => {
    const promise = uploadWithProgress(new File(['x'], 'a.txt'), () => {});
    const xhr = FakeXHR.instances[0];
    xhr.status = 413;
    xhr.responseText = JSON.stringify({ error: 'File too large' });
    (xhr as unknown as { listeners: Record<string, () => void> }).listeners.load();
    await expect(promise).rejects.toThrow('File too large');
  });
});

describe('FileOperationsManager in phone chat mode', () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hands picked and pasted images to the composer instead of typing paths now', async () => {
    const { manager, sendInputText } = makeManager();
    const attachToComposer = vi.fn(() => true);
    const callbacks = (manager as unknown as { callbacks: FileOperationsCallbacks }).callbacks;
    manager.setCallbacks({ ...callbacks, attachToComposer });

    const photo = new File(['x'], 'a.png', { type: 'image/png' });
    await manager.handleImagesPicked([photo]);
    const paste = new Event('paste', { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => photo }] },
    });
    await manager.handlePaste(paste);

    expect(attachToComposer).toHaveBeenCalledTimes(2);
    expect(attachToComposer).toHaveBeenCalledWith([photo]);
    expect(FakeXHR.instances).toHaveLength(0);
    expect(sendInputText).not.toHaveBeenCalled();
  });
});
