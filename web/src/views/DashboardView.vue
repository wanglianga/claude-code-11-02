<template>
  <div>
    <div class="toolbar">
      <el-date-picker v-model="date" type="date" value-format="YYYY-MM-DD" :clearable="false" @change="load" />
      <el-button type="primary" :loading="generating" @click="generate">生成当日任务</el-button>
      <el-button @click="rerunWindow">重跑近 3 天窗口</el-button>
      <span class="spacer" />
      <el-tag v-if="data.summary" type="warning">待人工接管 {{ data.summary.openInterventions }}</el-tag>
      <el-tag v-if="data.summary" type="danger">映射异常 {{ data.summary.openIssues }}</el-tag>
    </div>

    <el-row :gutter="12" class="summary" v-if="data.summary">
      <el-col :span="6"><el-card><div class="num">{{ data.summary.covered }}/{{ data.summary.cells }}</div><div class="lbl">已覆盖 门店×平台</div></el-card></el-col>
      <el-col :span="6"><el-card><div class="num warn">{{ data.summary.missing }}</div><div class="lbl">缺报</div></el-card></el-col>
      <el-col :span="6"><el-card><div class="num">{{ data.summary.openInterventions }}</div><div class="lbl">人工接管</div></el-card></el-col>
      <el-col :span="6"><el-card><div class="num">{{ data.summary.openIssues }}</div><div class="lbl">映射异常</div></el-card></el-col>
    </el-row>

    <el-card class="mt">
      <template #header>采集矩阵（{{ data.date }}）</template>
      <el-table :data="matrixRows" border size="small">
        <el-table-column label="门店" width="160">
          <template #default="{ row }">
            <b>{{ row.store_code }}</b> {{ row.store_name }}
            <el-tag size="small" effect="plain">{{ row.kind === 'direct' ? '直营' : '加盟' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column v-for="p in platforms" :key="p" :label="p">
          <template #default="{ row }">
            <div v-if="row.cells[p]">
              <template v-if="row.cells[p].tasks && row.cells[p].tasks.length">
                <el-tooltip v-for="t in row.cells[p].tasks" :key="t.taskId" :content="`${t.username}${t.lastError ? '：' + t.lastError : ''}`">
                  <el-tag class="cell-tag" :type="statusType(t.status)" size="small" @click="$router.push(`/tasks/${t.taskId}`)">
                    {{ t.username }} {{ statusLabel(t.status) }}
                  </el-tag>
                </el-tooltip>
              </template>
              <el-tag v-else class="cell-tag" size="small" type="info" effect="plain">未生成任务</el-tag>
              <div class="files">
                <el-icon v-if="+row.cells[p].active_files > 0" color="#67c23a"><CircleCheckFilled /></el-icon>
                <span v-if="+row.cells[p].active_files > 0">有效文件 {{ row.cells[p].active_files }}</span>
                <span v-else class="miss">缺报</span>
              </div>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card class="mt">
      <template #header>缺报清单</template>
      <el-table :data="data.missing" size="small" border>
        <el-table-column prop="store" label="门店" width="120" />
        <el-table-column prop="platform" label="平台" width="120" />
        <el-table-column prop="status" label="任务状态" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { CircleCheckFilled } from '@element-plus/icons-vue';
import { api, STATUS_META } from '../api';

const today = new Date().toISOString().slice(0, 10);
const date = ref(today);
const data = ref<any>({ cells: [], missing: [], summary: null, date: '' });
const generating = ref(false);
let timer: any = null;

const platforms = computed(() => [...new Set((data.value.cells || []).map((c: any) => c.platform_code))]);
const matrixRows = computed(() => {
  const rows: Record<string, any> = {};
  for (const c of data.value.cells || []) {
    rows[c.store_code] = rows[c.store_code] || { store_code: c.store_code, store_name: c.store_name, kind: c.kind, cells: {} };
    rows[c.store_code].cells[c.platform_code] = c;
  }
  return Object.values(rows);
});

const statusLabel = (s: string) => STATUS_META[s]?.label || s;
const statusType = (s: string) => STATUS_META[s]?.type || 'info';

async function load() {
  const r = await api.get('/dashboard', { params: { date: date.value } });
  data.value = r.data;
}
async function generate() {
  generating.value = true;
  try {
    const r = await api.post('/tasks/generate', { date: date.value });
    ElMessage.success(`已生成并入队 ${r.data.enqueued} 个任务`);
    setTimeout(load, 800);
  } finally {
    generating.value = false;
  }
}
async function rerunWindow() {
  const from = new Date(new Date(date.value).getTime() - 2 * 86400000).toISOString().slice(0, 10);
  await ElMessageBox.confirm(`将重跑 ${from} ~ ${date.value} 的全部任务（含失败/待人工）`, '重跑窗口');
  const r = await api.post('/tasks/rerun-window', { from, to: date.value });
  ElMessage.success(`窗口 ${r.data.days} 天，入队 ${r.data.enqueued} 个任务`);
  setTimeout(load, 800);
}

onMounted(() => {
  load();
  timer = setInterval(load, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.spacer { flex: 1; }
.summary .num { font-size: 26px; font-weight: 700; }
.summary .num.warn { color: #e6a23c; }
.summary .lbl { color: #909399; font-size: 13px; }
.mt { margin-top: 12px; }
.cell-tag { margin: 2px 4px 2px 0; cursor: pointer; }
.files { font-size: 12px; color: #606266; margin-top: 2px; }
.files .miss { color: #f56c6c; }
</style>
