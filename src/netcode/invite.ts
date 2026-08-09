export function createInviteUrl(currentUrl: string, peerId: string) {
    const id = peerId.trim();
    if (!id) throw new Error('cannot create an invite URL without a peer ID');
    const url = new URL(currentUrl);
    url.search = '';
    url.hash = '';
    url.searchParams.set('invite', id);
    return url.toString();
}

export function getInvitePeerId(currentUrl: string) {
    const peerId = new URL(currentUrl).searchParams.get('invite')?.trim();
    return peerId || null;
}
