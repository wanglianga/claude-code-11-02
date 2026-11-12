<template>
  <el-card style="max-width: 640px">
    <template #header>人工补传（覆盖同一门店×平台×账号×日期的自动数据）</template>
    <el-form label-width="90px">
      <el-form-item label="门店">
        <el-select v-model="form.storeId" style="width: 100%" @change="filterAccounts">
          <el-option v-for="s in meta.stores" :key="s.id" :label="`${s.code} ${s.name}`" :value="s.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="平台">
        <el-select v-model="form.platformId" style="width: 100%" @change="filterAccounts">
          <el-option v-for="p in meta.platforms" :key="p.id" :label="`${p.code} ${p.name}`" :value="p.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="账号">
        <el-select v-model="form.accountId" style="width: 100%">
          <el-option v-for="a in accountOptions" :key="a.id" :label="a.username" :value="a.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="营业日">
        <el-date-picker v-model="form.bizDate" type="date" value-format="YYYY-MM-DD" :clearable="false" />
      </el-form-item>
      <el-form-item label="报表文件">
        <input type="file" @change="onFile" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="uploading" @click="submit">上传并解析</el-button>
      </el-form-item>
    </el-form>
    <el-alert v-if="result" type="success" :closable="false"
      :title="`已登记 fileId=${result.fileId}，修订 r${result.revision}，覆盖 ${result.superseded.length} 份旧文件，解析已入队`" />
  </el-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api';

const meta = ref<any>({ stores: [], platforms: [], accounts: [] });
const form = reactive<any>({ storeId: null, platformId: null, accountId: null, bizDate: new Date().toISOString().slice(0, 10) });
const file = ref<File | null>(null);
const uploading = ref(false);
const result = ref<any>(null);

const accountOptions = computed(() =>
  meta.value.accounts.filter((a: any) => a.store_id === form.storeId && a.platform_id === form.platformId),
);
function filterAccounts() {
  form.accountId = accountOptions.value[0]?.id ?? null;
}
function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] || null;
}
async function submit() {
  if (!file.value || !form.accountId) {
    ElMessage.warning('请选择账号与文件');
    return;
  }
  uploading.value = true;
  result.value = null;
  try {
    const fd = new FormData();
    fd.append('file', file.value);
    fd.append('storeId', String(form.storeId));
    fd.append('platformId', String(form.platformId));
    fd.append('accountId', String(form.accountId));
    fd.append('bizDate', form.bizDate);
    result.value = (await api.post('/files/upload', fd)).data;
    ElMessage.success('上传成功，解析已入队');
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '上传失败');
  } finally {
    uploading.value = false;
  }
}
onMounted(async () => {
  meta.value = (await api.get('/meta')).data;
  form.storeId = meta.value.stores[0]?.id;
  form.platformId = meta.value.platforms[0]?.id;
  filterAccounts();
});
</script>
