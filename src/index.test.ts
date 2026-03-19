import { describe, it } from 'node:test';
import assert from 'node:assert';
import { handleApplication, viteWrapper } from './index.js';
import { EventEmitter } from 'node:events';

describe('handleApplication', () => {
	it('should configure vite with provided scope.directory', async (t) => {
		const createServerMock = t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares: t.mock.fn(),
		}));

		const scope = new EventEmitter() as any;
		scope.directory = '/test/dir';

		await handleApplication(scope);

		assert.strictEqual(createServerMock.mock.callCount(), 1);
		const call = createServerMock.mock.calls[0];
		assert.strictEqual((call.arguments[0] as any).root, '/test/dir');
		assert.strictEqual((call.arguments[0] as any).server.middlewareMode, true);
	});

	it('should close vite instance when scope emits close', async (t) => {
		const closeMock = t.mock.fn(async () => {});
		t.mock.method(viteWrapper, 'createServer', async () => ({
			close: closeMock,
			middlewares: t.mock.fn(),
		}));

		const scope = new EventEmitter() as any;
		scope.directory = '/test/dir';

		await handleApplication(scope);

		scope.emit('close');

		assert.strictEqual(closeMock.mock.callCount(), 1);
	});

	it('should configure vite as a middleware if scope.server.http is present', async (t) => {
		const middlewaresMock = t.mock.fn();
		t.mock.method(viteWrapper, 'createServer', async () => ({
			close: t.mock.fn(),
			middlewares: middlewaresMock,
		}));

		let httpHandler: any;
		const scope = new EventEmitter() as any;
		scope.directory = '/test/dir';
		scope.server = {
			http: (handler: any) => {
				httpHandler = handler;
			},
		};

		await handleApplication(scope);

		assert.ok(httpHandler, 'http handler should be set');

		const mockRequest = { _nodeRequest: 'req', _nodeResponse: 'res' };
		await httpHandler(mockRequest);

		assert.strictEqual(middlewaresMock.mock.callCount(), 1);
		const call = middlewaresMock.mock.calls[0];
		assert.strictEqual(call.arguments[0], 'req');
		assert.strictEqual(call.arguments[1], 'res');
	});
});
