import { defineStore } from 'pinia';
import { ref } from 'vue';
import { apiFetch } from '../api';

export interface DataSource {
	id: number;
	name: string;
	host?: string;
	port?: number;
	user?: string;
	database_name?: string;
	is_local: number;
	created_by?: number | null;
	description?: string;
	created_at: string;
}

export interface UploadedTable {
	id: number;
	datasource_id: number;
	user_id: number;
	table_name: string;
	display_name: string;
	created_at: string;
}

export const useDataSourceStore = defineStore('datasource', () => {
	const list = ref<DataSource[]>([]);
	const loading = ref(false);
	const error = ref<string | null>(null);
	const suggestionsCache = ref<Record<number, string[]>>({});
	const suggestionsLoading = ref<Record<number, boolean>>({});

	async function fetchAll() {
		loading.value = true;
		error.value = null;
		try {
			const res = await apiFetch('/datasources');
			list.value = await res.json();
		} catch (e: any) {
			error.value = e.message;
		} finally {
			loading.value = false;
		}
	}

	async function testConnection(config: {
		host: string;
		port: number;
		user: string;
		password: string;
		database_name: string;
	}): Promise<void> {
		const res = await apiFetch('/datasources/test-connection', {
			method: 'POST',
			body: JSON.stringify(config),
		});
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '连接失败');
		}
	}

	async function create(body: {
		name: string;
		host?: string;
		port?: number;
		user?: string;
		password?: string;
		database_name?: string;
		description?: string;
	}): Promise<DataSource> {
		const res = await apiFetch('/datasources', {
			method: 'POST',
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '连接失败');
		}
		const created: DataSource = await res.json();
		list.value.push(created);
		return created;
	}

	async function remove(id: number) {
		const res = await apiFetch(`/datasources/${id}`, { method: 'DELETE' });
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '删除失败');
		}
		list.value = list.value.filter(d => d.id !== id);
	}

	async function grant(datasourceId: number, userId: number) {
		const res = await apiFetch(`/datasources/${datasourceId}/grant`, {
			method: 'POST',
			body: JSON.stringify({ userId }),
		});
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '授权失败');
		}
	}

	async function revoke(datasourceId: number, userId: number) {
		const res = await apiFetch(`/datasources/${datasourceId}/revoke`, {
			method: 'POST',
			body: JSON.stringify({ userId }),
		});
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '撤销失败');
		}
	}

	async function listPermissions(datasourceId: number): Promise<{ id: number; email: string; name: string }[]> {
		const res = await apiFetch(`/datasources/${datasourceId}/permissions`);
		if (!res.ok) throw new Error('获取授权列表失败');
		return res.json();
	}

	async function uploadTable(datasourceId: number, file: File, displayName: string): Promise<UploadedTable> {
		const form = new FormData();
		form.append('file', file);
		form.append('displayName', displayName);
		const res = await apiFetch(`/datasources/${datasourceId}/tables`, {
			method: 'POST',
			body: form,
		});
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '上传失败');
		}
		return res.json();
	}

	async function listTables(datasourceId: number): Promise<UploadedTable[]> {
		const res = await apiFetch(`/datasources/${datasourceId}/tables`);
		if (!res.ok) throw new Error('获取表列表失败');
		return res.json();
	}

	async function deleteTable(datasourceId: number, tableId: number): Promise<void> {
		const res = await apiFetch(`/datasources/${datasourceId}/tables/${tableId}`, { method: 'DELETE' });
		if (!res.ok) {
			const err = await res.json();
			throw new Error(err.message || '删除失败');
		}
	}

	async function fetchSuggestions(datasourceId: number): Promise<void> {
		if (suggestionsCache.value[datasourceId] || suggestionsLoading.value[datasourceId]) return;
		suggestionsLoading.value[datasourceId] = true;
		try {
			const res = await apiFetch(`/datasources/${datasourceId}/suggestions`);
			const data = await res.json();
			suggestionsCache.value[datasourceId] = data.questions;
		} catch {
			// 静默失败，前端回退到默认问题
		} finally {
			suggestionsLoading.value[datasourceId] = false;
		}
	}

	return { list, loading, error, suggestionsCache, suggestionsLoading, fetchAll, testConnection, create, remove, grant, revoke, listPermissions, uploadTable, listTables, deleteTable, fetchSuggestions };
});
