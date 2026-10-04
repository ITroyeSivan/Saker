// Synthetic portal used only for the local Desktop acceptance test.
export const mapClientKey = 'public-fixture-map-key';
export const accessToken = 'fixture-front';
export function ownTeacher() { return fetch('/teacher?id=own', {headers: {Authorization: 'Fixture front'}}); }
export function teacherById(id) { return fetch('/teacher?id=' + id, {headers: {Authorization: 'Fixture front'}}); }
export function changeMenu(roleId) { return roleId === 'admin' ? ['admin'] : ['map']; }
export function backendMenu() { return fetch('/admin-menu', {headers: {Authorization: 'Fixture front'}}); }
export function logoPage() { return fetch('/logo'); }
