import assert from 'node:assert/strict';
import test from 'node:test';
import { createInviteUrl, getInvitePeerId } from '../src/netcode/invite.ts';

test('invite URL contains only the host peer ID query parameter', () => {
    assert.equal(
        createInviteUrl('https://bblade.example/game?old=value#section', 'host-peer-123'),
        'https://bblade.example/game?invite=host-peer-123'
    );
});

test('invite peer ID is read immediately from the page URL', () => {
    assert.equal(
        getInvitePeerId('https://bblade.example/?invite=host-peer-123'),
        'host-peer-123'
    );
    assert.equal(getInvitePeerId('https://bblade.example/'), null);
});
