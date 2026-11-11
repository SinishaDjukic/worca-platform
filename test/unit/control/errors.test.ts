// onError's mapping of thrown errors to 4xx answers (src/control/index.ts clientError).
import { describe, expect, it } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import { APIError } from 'better-call';
import { clientError } from '../../../packages/platform/src/control/index';

describe('clientError', () => {
  it('passes HTTPException codes through', () => {
    expect(clientError(new HTTPException(409, { message: 'already_deleting' }))).toEqual({ status: 409, code: 'already_deleting' });
  });
  it("maps Better Auth's APIError by statusCode and body.code instead of a 500", () => {
    expect(clientError(new APIError('FORBIDDEN', { code: 'YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION', message: 'x' }))).toEqual({
      status: 403,
      code: 'you_are_not_allowed_to_create_a_new_organization',
    });
    expect(clientError(new APIError('BAD_REQUEST'))).toEqual({ status: 400, code: 'request_refused' });
  });
  it('leaves server errors and plain errors alone', () => {
    expect(clientError(new APIError('INTERNAL_SERVER_ERROR'))).toBeNull();
    expect(clientError(new Error('boom'))).toBeNull();
  });
});
