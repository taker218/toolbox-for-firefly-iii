<template>
  <div class="tool-view">
    <!-- Wizard Stepper -->
    <WizardStepper
      v-model="currentStep"
      :steps="wizardSteps"
      :can-proceed="canProceed"
      :loading="stepLoading"
      :disabled="loading || linking"
      :next-button-text="nextButtonText"
      :status-message="statusMessage"
      :status-color="statusColor"
      @next="onStepNext"
      @reset="onReset"
    >
      <!-- Step 1: Select Date Range -->
      <template #content-1>
        <DateRangeStep
          v-model:start-date="startDate"
          v-model:end-date="endDate"
          :transactions="preview.transactions.value"
          :count="preview.count.value ?? 0"
          :loading="preview.fetching.value"
          :loading-more="preview.loadingMore.value"
          :loading-text="t('common.status.fetchingTransactions')"
          @change="debouncedFetchCount"
          @load-more="loadMoreTransactions"
          @refresh="preview.refresh()"
        >
          <template #options>
            <v-divider class="my-4" />
            <div class="text-subtitle-2 mb-2">{{ t('views.links.options.detectors') }}</div>
            <div class="d-flex flex-wrap ga-4">
              <v-checkbox
                v-for="detector in DETECTORS"
                :key="detector"
                v-model="options.detectors"
                :value="detector"
                :label="t(`views.links.detectors.${detector}`)"
                density="compact"
                hide-details
              />
            </div>
            <v-row class="mt-2" dense>
              <v-col cols="12" md="4">
                <v-text-field
                  v-model.number="options.maxDaysApart"
                  type="number"
                  min="1"
                  max="365"
                  :label="t('views.links.options.maxDaysApart')"
                  density="compact"
                  variant="outlined"
                  hide-details
                />
              </v-col>
              <v-col cols="12" md="4">
                <v-slider
                  v-model="options.minConfidence"
                  :min="0.3"
                  :max="1"
                  :step="0.05"
                  :label="t('views.links.options.minConfidence')"
                  thumb-label
                  density="compact"
                  hide-details
                >
                  <template #thumb-label="{ modelValue }">
                    {{ Math.round(modelValue * 100) }}%
                  </template>
                </v-slider>
              </v-col>
              <v-col cols="12" md="4">
                <v-switch
                  v-model="options.allowPartialAmount"
                  :label="t('views.links.options.allowPartialAmount')"
                  color="primary"
                  density="compact"
                  hide-details
                />
              </v-col>
            </v-row>
          </template>
        </DateRangeStep>
      </template>

      <!-- Step 2: Find & Review Links -->
      <template #content-2>
        <!-- Progress Bar (shown during analysis) -->
        <ProgressCard
          :show="loading"
          :current="progress.current.value"
          :total="progress.total.value"
          :message="progress.message.value"
          icon="mdi-link-variant"
        />

        <!-- Empty State - Not yet searched -->
        <EmptyState
          v-if="!loading && !hasSearched"
          icon="mdi-link-variant"
          :title="t('common.messages.readyToAnalyze')"
          :subtitle="t('views.links.clickToScan')"
        />

        <!-- Empty State - Nothing found -->
        <EmptyState
          v-else-if="!loading && candidates.length === 0 && hasSearched"
          icon="mdi-check-circle"
          :title="t('views.links.noLinksFound')"
          :subtitle="t('views.links.noLinksFoundSubtitle')"
        />

        <!-- Results -->
        <template v-else-if="candidates.length > 0">
          <ResultsSummaryCard
            :stats="summaryStats"
            :selectable-count="candidates.length"
            :all-selected="selection.allSelected.value"
            :selected-count="selection.selected.value.length"
            :action-text="t('views.links.linkSelected')"
            action-icon="mdi-link-plus"
            :action-loading="linking"
            @toggle-select-all="selection.toggleAll(candidates.map((c) => c.id))"
            @action="linkSelected"
          />

          <v-card
            v-for="candidate in candidates"
            :key="candidate.id"
            rounded="lg"
            class="mb-3"
            :variant="selection.isSelected(candidate.id) ? 'tonal' : 'elevated'"
          >
            <v-card-title class="d-flex align-center flex-wrap ga-2 py-2">
              <v-checkbox-btn
                class="flex-grow-0"
                :model-value="selection.isSelected(candidate.id)"
                @update:model-value="selection.toggle(candidate.id, $event)"
              />
              <v-chip
                v-for="detector in candidate.detectors"
                :key="detector"
                size="small"
                :color="DETECTOR_STYLES[detector].color"
                :prepend-icon="DETECTOR_STYLES[detector].icon"
              >
                {{ t(`views.links.detectors.${detector}`) }}
              </v-chip>
              <v-chip v-if="candidate.isPartial" size="small" color="amber" variant="tonal">
                {{ t('views.links.partial') }}
              </v-chip>
              <v-chip
                v-if="candidate.matchedReference"
                size="small"
                variant="outlined"
                prepend-icon="mdi-identifier"
              >
                {{ candidate.matchedReference }}
              </v-chip>
              <v-spacer />
              <ConfidenceBreakdown
                :score="candidate.matchScore"
                :items="getBreakdownItems(candidate.confidenceBreakdown)"
              />
              <v-tooltip location="top">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-close"
                    size="x-small"
                    variant="text"
                    @click="dismissCandidate(candidate.id)"
                  />
                </template>
                <span>{{ t('views.links.dismiss') }}</span>
              </v-tooltip>
            </v-card-title>

            <v-card-text>
              <v-row dense>
                <v-col cols="12" md="5" class="d-flex flex-column">
                  <div class="text-caption text-medium-emphasis mb-1">
                    {{ t('views.links.original') }}
                  </div>
                  <TransactionCard
                    :transaction="candidate.original.split"
                    variant="outlined"
                    class="flex-grow-1"
                  />
                </v-col>
                <v-col cols="12" md="2" class="d-flex flex-column align-center justify-center">
                  <v-icon icon="mdi-arrow-right-bold" class="link-arrow mb-2" />
                  <v-select
                    v-model="linkTypeByCandidate[candidate.id]"
                    :items="linkTypeItems"
                    :label="t('views.links.linkType')"
                    density="compact"
                    variant="outlined"
                    hide-details
                    class="w-100"
                  />
                </v-col>
                <v-col cols="12" md="5" class="d-flex flex-column">
                  <div class="text-caption text-medium-emphasis mb-1">
                    {{ t('views.links.related') }}
                  </div>
                  <TransactionCard
                    :transaction="candidate.related.split"
                    variant="outlined"
                    class="flex-grow-1"
                  />
                </v-col>
              </v-row>
            </v-card-text>
          </v-card>
        </template>
      </template>

      <!-- Final Action Button (Find Links) -->
      <template #final-action>
        <FinalActionButton
          v-if="currentStep === 2"
          :has-run="hasSearched"
          :text="t('navigation.links')"
          :rerun-text="t('common.buttons.rescan')"
          icon="mdi-magnify"
          :loading="loading"
          @click="findLinks"
        />
      </template>
    </WizardStepper>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '../services/api';
import type {
  LinkCandidate,
  LinkConfidenceBreakdown,
  LinkDetector,
  LinkTypeInfo,
} from '@shared/types/app';
import {
  WizardStepper,
  TransactionCard,
  ConfidenceBreakdown,
  EmptyState,
  DateRangeStep,
  ProgressCard,
  ResultsSummaryCard,
  FinalActionButton,
} from '../components/common';
import type { BreakdownItem } from '../components/common/ConfidenceBreakdown.vue';
import {
  useProgress,
  useSelection,
  useTransactionPreview,
  useStreamProcessor,
  useSnackbar,
  type StreamEvent,
  type ProgressData,
  type ValidationErrorData,
} from '../composables';
import { LinkCandidateSchema } from '../utils';

/** Maximum links per create-bulk request (matches server validation) */
const LINK_BATCH_SIZE = 100;

const DETECTORS: LinkDetector[] = ['refund', 'reimbursement', 'reference'];

const DETECTOR_STYLES: Record<LinkDetector, { color: string; icon: string }> = {
  refund: { color: 'deep-orange', icon: 'mdi-cash-refund' },
  reimbursement: { color: 'teal', icon: 'mdi-account-cash' },
  reference: { color: 'blue', icon: 'mdi-pound' },
};

// i18n
const { t } = useI18n();

// Snackbar
const { showSnackbar } = useSnackbar();

// Wizard state
const currentStep = ref(1);
const wizardSteps = computed(() => [
  { title: t('common.steps.dateRange'), subtitle: t('common.steps.selectTransactionsToAnalyze') },
  {
    title: t('common.steps.findReview'),
    subtitle: t('views.links.steps.findReview.subtitle'),
  },
]);

// Step 1: Date range and options
const startDate = ref<string>();
const endDate = ref<string>();
const options = reactive({
  detectors: [...DETECTORS],
  maxDaysApart: 90,
  minConfidence: 0.6,
  allowPartialAmount: true,
});

// Transaction preview composable
const preview = useTransactionPreview();

// Step 2: Analysis state
const loading = ref(false);
const linking = ref(false);
const hasSearched = ref(false);
const candidates = ref<LinkCandidate[]>([]);
const linkTypes = ref<LinkTypeInfo[]>([]);
const linkTypeByCandidate = reactive<Record<string, string>>({});

// Progress tracking composable
const progress = useProgress('Initializing...');

// Selection composable
const selection = useSelection<string>(() => candidates.value.length);

const linkTypeItems = computed(() =>
  linkTypes.value.map((lt) => ({ title: lt.name, value: lt.name }))
);

const summaryStats = computed(() =>
  DETECTORS.map((detector) => ({
    label: t(`views.links.detectors.${detector}`),
    value: candidates.value.filter((c) => c.detectors.includes(detector)).length,
    ...DETECTOR_STYLES[detector],
  }))
);

// Computed: Can proceed to next step
const canProceed = computed(() => {
  switch (currentStep.value) {
    case 1:
      return (
        preview.count.value !== null && preview.count.value > 0 && options.detectors.length > 0
      );
    default:
      return true;
  }
});

const stepLoading = computed(() => currentStep.value === 1 && preview.fetching.value);

const nextButtonText = computed(() =>
  currentStep.value === 1 ? t('navigation.links') : t('common.buttons.next')
);

const statusMessage = computed(() => {
  if (currentStep.value === 1) {
    if (preview.fetching.value) return t('common.messages.fetching');
    if (preview.count.value === null) return '';
    if (preview.count.value === 0) return t('common.messages.noTransactionsFound');
    if (options.detectors.length === 0) return t('views.links.selectDetector');
    return t('common.labels.countTransactions', { count: preview.count.value });
  }
  return '';
});

const statusColor = computed(() => {
  if (currentStep.value === 1 && preview.count.value !== null) {
    return canProceed.value ? 'success' : 'warning';
  }
  return '';
});

// Debounce helper
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedFetchCount() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    fetchTransactionCount();
  }, 500);
}

async function fetchTransactionCount() {
  await preview.fetchCount('/links/count-transactions', {
    startDate: startDate.value,
    endDate: endDate.value,
  });
}

async function loadMoreTransactions() {
  await preview.loadMore('/links/count-transactions', {
    startDate: startDate.value,
    endDate: endDate.value,
  });
}

async function fetchLinkTypes() {
  try {
    const response = await api.get('/links/link-types');
    linkTypes.value = response.data.data;
  } catch (error) {
    showSnackbar(
      error instanceof Error ? error.message : t('views.links.failedToLoadLinkTypes'),
      'error'
    );
  }
}

// Handle step navigation
function onStepNext(step: number) {
  // Auto-start link finding when entering step 2
  if (step === 2) {
    findLinks();
  }
}

// Reset wizard
function onReset() {
  currentStep.value = 1;
  startDate.value = undefined;
  endDate.value = undefined;
  preview.reset();
  progress.reset();
  selection.clear();
  loading.value = false;
  hasSearched.value = false;
  candidates.value = [];
}

// Stream processor
const { processStream } = useStreamProcessor();

// Track validation errors during stream processing
const validationErrorCount = ref(0);

function handleStreamEvent(
  event: StreamEvent<LinkCandidate | ProgressData | ValidationErrorData | { error: string }>
) {
  switch (event.type) {
    case 'progress': {
      const progressData = event.data as ProgressData;
      progress.update(
        progressData.current || 0,
        progressData.total || 0,
        progressData.message || ''
      );
      break;
    }
    case 'result': {
      const candidate = event.data as LinkCandidate;
      if (candidate?.id) {
        candidates.value.push(candidate);
        linkTypeByCandidate[candidate.id] = resolveLinkType(candidate.suggestedLinkType);
      }
      break;
    }
    case 'validation-error': {
      validationErrorCount.value++;
      break;
    }
    case 'error': {
      const errorData = event.data as { error: string };
      showSnackbar(errorData?.error || t('common.errors.anErrorOccurred'), 'error');
      break;
    }
    case 'complete':
      progress.message.value = 'Complete!';
      break;
  }
}

/** Falls back to "Related" if the suggested link type does not exist in this Firefly III instance */
function resolveLinkType(suggested: string): string {
  const names = linkTypes.value.map((lt) => lt.name);
  if (names.length === 0 || names.includes(suggested)) return suggested;
  return names.includes('Related') ? 'Related' : names[0];
}

async function findLinks() {
  loading.value = true;
  hasSearched.value = true;
  candidates.value = [];
  selection.clear();
  progress.reset();
  validationErrorCount.value = 0;
  progress.message.value = 'Connecting...';

  try {
    if (linkTypes.value.length === 0) {
      await fetchLinkTypes();
    }

    await processStream(
      '/api/links/stream-find',
      {
        startDate: startDate.value,
        endDate: endDate.value,
        options: { ...options, maxDaysApart: Math.max(1, Math.round(options.maxDaysApart)) },
      },
      handleStreamEvent,
      { includeSession: true, resultSchema: LinkCandidateSchema }
    );

    if (validationErrorCount.value > 0) {
      showSnackbar(
        t('common.messages.itemsSkipped', { count: validationErrorCount.value }),
        'warning'
      );
    } else if (candidates.value.length > 0) {
      showSnackbar(t('views.links.foundLinks', { count: candidates.value.length }), 'info');
    }
  } catch (error) {
    showSnackbar(error instanceof Error ? error.message : t('views.links.failedToFind'), 'error');
  } finally {
    loading.value = false;
  }
}

async function linkSelected() {
  const selected = candidates.value.filter((c) => selection.isSelected(c.id));
  if (selected.length === 0) return;

  linking.value = true;
  const linkedIds = new Set<string>();
  let failedCount = 0;

  try {
    for (let i = 0; i < selected.length; i += LINK_BATCH_SIZE) {
      const batch = selected.slice(i, i + LINK_BATCH_SIZE);
      const response = await api.post('/links/create-bulk', {
        // Firefly III reads a link as "<outward> <link type inward text> <inward>",
        // e.g. "purchase is (partially) refunded by refund", so the related transaction is inward
        links: batch.map((c) => ({
          inwardId: c.related.journalId,
          outwardId: c.original.journalId,
          linkTypeName: linkTypeByCandidate[c.id] || c.suggestedLinkType,
        })),
      });

      const { successful, failed } = response.data.data as {
        successful: { inwardId: string; outwardId: string }[];
        failed: unknown[];
      };
      failedCount += failed.length;
      for (const link of successful) {
        const candidate = batch.find(
          (c) => c.related.journalId === link.inwardId && c.original.journalId === link.outwardId
        );
        if (candidate) linkedIds.add(candidate.id);
      }
    }
  } catch (error) {
    showSnackbar(error instanceof Error ? error.message : t('views.links.failedToLink'), 'error');
  } finally {
    candidates.value = candidates.value.filter((c) => !linkedIds.has(c.id));
    for (const id of linkedIds) selection.toggle(id, false);
    linking.value = false;
  }

  if (linkedIds.size > 0) {
    showSnackbar(t('views.links.linkedCount', { count: linkedIds.size }), 'success');
  }
  if (failedCount > 0) {
    showSnackbar(t('views.links.linkFailedCount', { count: failedCount }), 'warning');
  }
}

// Dismiss a candidate (user decided the transactions are not related)
function dismissCandidate(candidateId: string) {
  if (selection.isSelected(candidateId)) {
    selection.toggle(candidateId, false);
  }
  candidates.value = candidates.value.filter((c) => c.id !== candidateId);
}

function getBreakdownItems(breakdown: LinkConfidenceBreakdown): BreakdownItem[] {
  return [
    {
      label: t('views.links.breakdown.referenceMatch'),
      value: breakdown.referenceMatch,
      max: 0.4,
    },
    { label: t('common.labels.amountMatch'), value: breakdown.amountMatch, max: 0.35 },
    {
      label: t('views.links.breakdown.counterpartyMatch'),
      value: breakdown.counterpartyMatch,
      max: 0.3,
    },
    { label: t('views.links.breakdown.keywordMatch'), value: breakdown.keywordMatch, max: 0.2 },
    {
      label: t('views.links.breakdown.dateProximity'),
      value: breakdown.dateProximity,
      max: 0.1,
    },
    {
      label: t('views.links.breakdown.unusualAmount'),
      value: breakdown.unusualAmount,
      max: 0.15,
    },
    {
      label: t('views.links.breakdown.uniqueAmount'),
      value: breakdown.uniqueAmount,
      max: 0.1,
    },
    {
      label: t('views.links.breakdown.sameAccount'),
      value: breakdown.sameAccount,
      max: 0.05,
      muted: true,
    },
  ];
}
</script>

<style scoped>
.tool-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
}

@media (max-width: 959px) {
  .link-arrow {
    transform: rotate(90deg);
  }
}
</style>
