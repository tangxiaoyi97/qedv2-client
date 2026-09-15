<script setup lang="ts">
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { dateText, type ManagementClient, type Page } from '../api.js';
import { query } from '../formats.js';
import { categoryLabel, feedbackCategoryIssues, feedbackIssueLabel, feedbackIssueText, type Capabilities, type Feedback, type FeedbackStatus } from '../server-types.js';
import { useDetailFocus } from '../useDetailFocus.js';
import { useRequest } from '../useRequest.js';
import PaginationBar from '../components/PaginationBar.vue';
import RequestState from '../components/RequestState.vue';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps<{ client: ManagementClient; capabilities: Capabilities }>();
const emit = defineEmits<{ sessionLost: [] }>();
const { busy, writing, error, notice, run, cancel } = useRequest(props.client, () => emit('sessionLost'));
const detailFocus = useDetailFocus(), detailRegion = detailFocus.region;
const result = shallowRef<Page<Feedback>>(), detail = shallowRef<Feedback>(), editStatus = ref<FeedbackStatus>('open');
const emptyFilters = () => ({ status: '', q: '', category: '', issueType: '', questionId: '' });
const filters = reactive(emptyFilters()), applied = reactive(emptyFilters());
const issueOptions = computed(() => feedbackCategoryIssues[filters.category] ?? Object.keys(feedbackIssueLabel));
watch(() => filters.category, () => {
  if (filters.issueType && !issueOptions.value.includes(filters.issueType)) filters.issueType = '';
});

async function load(page = result.value?.page ?? 1) {
  result.value = undefined;
  await run((signal) => props.client.request<Page<Feedback>>(query('/feedback', {
    page, status: applied.status,
    ...(props.capabilities.feedbackFilters ? { q: applied.q, category: applied.category } : {}),
    ...(props.capabilities.feedbackDetails ? { issueType: applied.issueType, questionId: applied.questionId } : {}),
  }), undefined, true, undefined, signal), (value) => { result.value = value; });
}
async function filter(reset = false) {
  if (reset) Object.assign(filters, emptyFilters());
  Object.assign(applied, filters, { q: filters.q.trim(), questionId: filters.questionId.trim() });
  detail.value = undefined;
  await load(1);
}
async function open(item: Feedback, event?: Event) {
  detailFocus.capture(event);
  detail.value = undefined;
  const loaded = await run((signal) => props.client.request<Feedback>(`/feedback/${encodeURIComponent(item.id)}`, undefined, true, undefined, signal), (value) => {
    detail.value = value;
    editStatus.value = value.status;
  });
  if (loaded) await detailFocus.reveal();
}
function closeDetail() { detail.value = undefined; void detailFocus.restore(); }
async function save() {
  const item = detail.value;
  if (!item || !props.capabilities.feedback) return;
  const ok = await run(() => props.client.request(`/feedback/${encodeURIComponent(item.id)}`, { status: editStatus.value }, true, 'PATCH'), () => { detail.value = undefined; }, true);
  if (ok) { await load(); notice.value = '反馈状态已保存。'; }
}
onMounted(() => load(1));
</script>

<template>
  <div class="panel-toolbar"><h3>反馈管理</h3><button type="button" :disabled="busy" @click="load()">刷新</button></div>
  <form class="filter-bar filter-fields" @submit.prevent="filter()">
    <div v-if="capabilities.feedbackFilters" class="field"><label for="feedback-search">主题关键词</label><input id="feedback-search" v-model="filters.q" type="search" maxlength="120" :disabled="writing" /></div>
    <div class="field"><label for="feedback-filter">处理状态</label><select id="feedback-filter" v-model="filters.status" :disabled="writing"><option value="">全部状态</option><option value="open">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select></div>
    <div v-if="capabilities.feedbackFilters" class="field"><label for="feedback-category">类型</label><select id="feedback-category" v-model="filters.category" :disabled="writing"><option value="">全部类型</option><option v-for="(label, key) in categoryLabel" :key="key" :value="key">{{ label }}</option></select></div>
    <div v-if="capabilities.feedbackDetails" class="field"><label for="feedback-issue-type">问题分类</label><select id="feedback-issue-type" v-model="filters.issueType" :disabled="writing"><option value="">全部分类</option><option v-for="issue in issueOptions" :key="issue" :value="issue">{{ feedbackIssueLabel[issue] }}</option></select></div>
    <div v-if="capabilities.feedbackDetails" class="field"><label for="feedback-question-id">题目 ID</label><input id="feedback-question-id" v-model="filters.questionId" type="search" maxlength="128" :disabled="writing" /></div>
    <button type="submit" :disabled="writing">筛选</button><button type="button" :disabled="writing" @click="filter(true)">重置</button>
  </form>
  <RequestState :busy="busy" :writing="writing" :error="error" :notice="notice" @cancel="cancel" />

  <section v-if="detail" ref="detailRegion" class="surface feedback-detail detail-region" tabindex="-1" aria-labelledby="feedback-detail-heading">
    <div class="panel-toolbar"><h3 id="feedback-detail-heading">{{ detail.subject }}</h3><button type="button" :disabled="writing" @click="closeDetail">关闭详情</button></div>
    <p class="muted">{{ detail.user?.username ?? '用户已删除' }} · {{ categoryLabel[detail.category] ?? detail.category }} · {{ dateText(detail.createdAt) }}</p>
    <p class="feedback-message">{{ detail.message }}</p>
    <dl class="detail-list">
      <dt>问题分类</dt><dd>{{ feedbackIssueText(detail.issueType) }}</dd>
      <dt>题目 ID</dt><dd class="mono">{{ detail.questionId || '—' }}</dd>
      <dt>小题 ID</dt><dd class="mono">{{ detail.context?.partId || '—' }}</dd>
      <dt>Core 来源</dt><dd class="mono">{{ detail.context?.coreBaseUrl || '—' }}</dd>
      <dt>题库提交</dt><dd class="mono">{{ detail.context?.bankCommit || '—' }}</dd>
      <dt>内容版本</dt><dd class="mono">{{ detail.context?.contentRevision || '—' }}</dd>
      <dt>客户端 / 平台</dt><dd>{{ detail.clientVersion || '—' }} / {{ detail.platform || '—' }}</dd>
      <dt>反馈回执</dt><dd class="mono">{{ detail.id }}</dd>
      <dt>提交 ID</dt><dd class="mono">{{ detail.submissionId || '—' }}</dd>
      <dt>关联请求 ID</dt><dd class="mono">{{ detail.requestId || '—' }}</dd>
    </dl>
    <form class="filter-bar" @submit.prevent="save"><label for="feedback-status">处理状态</label><select id="feedback-status" v-model="editStatus" :disabled="busy"><option value="open">待处理</option><option value="in_progress">处理中</option><option value="resolved">已解决</option></select><button type="submit" class="primary" :disabled="busy || editStatus === detail.status">保存状态</button></form>
  </section>

  <div v-if="result" class="table-wrap" tabindex="0" role="region" aria-label="反馈列表，可横向滚动">
    <table>
      <caption class="sr-only">反馈列表</caption>
      <thead><tr><th scope="col">主题</th><th scope="col">用户</th><th scope="col">类型 / 问题分类</th><th scope="col">题目引用</th><th scope="col">状态</th><th scope="col">提交时间</th></tr></thead>
      <tbody>
        <tr v-for="item in result.items" :key="item.id">
          <td><button type="button" class="link-button" :disabled="busy" @click="open(item, $event)">{{ item.subject }}</button></td>
          <td>{{ item.user?.username ?? '用户已删除' }}</td>
          <td>{{ categoryLabel[item.category] ?? item.category }}<span class="record-id">{{ feedbackIssueText(item.issueType) }}</span></td>
          <td><span class="mono">{{ item.questionId || '—' }}</span><span v-if="item.context?.partId" class="record-id mono">{{ item.context.partId }}</span></td>
          <td><StatusBadge :value="item.status" /></td><td>{{ dateText(item.createdAt) }}</td>
        </tr>
        <tr v-if="!result.items.length"><td colspan="6" class="empty-cell">暂无符合条件的反馈。</td></tr>
      </tbody>
    </table>
  </div>
  <PaginationBar v-if="result" :result="result" :busy="busy" @change="detail = undefined; load($event)" />
</template>
