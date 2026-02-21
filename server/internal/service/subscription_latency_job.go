package service

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"
	"time"

	"all-monitor/server/internal/model"
)

const subscriptionLatencyJobRetention = 15 * time.Minute

type SubscriptionLatencyJobNode struct {
	NodeUID   string    `json:"node_uid"`
	LatencyMS *int      `json:"latency_ms,omitempty"`
	ErrorMsg  string    `json:"error_msg,omitempty"`
	CheckedAt time.Time `json:"checked_at"`
}

type SubscriptionLatencyJobStatus struct {
	JobID      string     `json:"job_id"`
	TargetID   uint       `json:"target_id"`
	Status     string     `json:"status"`
	Total      int        `json:"total"`
	Done       int        `json:"done"`
	Success    int        `json:"success"`
	Failed     int        `json:"failed"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	UpdatedAt  time.Time  `json:"updated_at"`
	Message    string     `json:"message,omitempty"`
}

type SubscriptionLatencyJobEvent struct {
	Type string                       `json:"type"`
	Job  SubscriptionLatencyJobStatus `json:"job"`
	Node *SubscriptionLatencyJobNode  `json:"node,omitempty"`
}

type subscriptionLatencyJob struct {
	mu          sync.RWMutex
	status      SubscriptionLatencyJobStatus
	subscribers map[chan SubscriptionLatencyJobEvent]struct{}
}

func (j *subscriptionLatencyJob) snapshot() SubscriptionLatencyJobStatus {
	j.mu.RLock()
	defer j.mu.RUnlock()
	return j.status
}

func (j *subscriptionLatencyJob) subscribe() chan SubscriptionLatencyJobEvent {
	ch := make(chan SubscriptionLatencyJobEvent, 32)
	j.mu.Lock()
	j.subscribers[ch] = struct{}{}
	j.mu.Unlock()
	return ch
}

func (j *subscriptionLatencyJob) unsubscribe(ch chan SubscriptionLatencyJobEvent) {
	j.mu.Lock()
	if _, ok := j.subscribers[ch]; ok {
		delete(j.subscribers, ch)
		close(ch)
	}
	j.mu.Unlock()
}

func (j *subscriptionLatencyJob) publish(event SubscriptionLatencyJobEvent) {
	j.mu.RLock()
	defer j.mu.RUnlock()
	for ch := range j.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func (j *subscriptionLatencyJob) update(mut func(*SubscriptionLatencyJobStatus), eventType string, node *SubscriptionLatencyJobNode) {
	j.mu.Lock()
	mut(&j.status)
	snap := j.status
	subs := make([]chan SubscriptionLatencyJobEvent, 0, len(j.subscribers))
	for ch := range j.subscribers {
		subs = append(subs, ch)
	}
	j.mu.Unlock()

	e := SubscriptionLatencyJobEvent{Type: eventType, Job: snap, Node: node}
	for _, ch := range subs {
		select {
		case ch <- e:
		default:
		}
	}
}

func (j *subscriptionLatencyJob) closeAll() {
	j.mu.Lock()
	for ch := range j.subscribers {
		close(ch)
		delete(j.subscribers, ch)
	}
	j.mu.Unlock()
}

func (s *TargetService) StartSubscriptionLatencyJob(id uint) (SubscriptionLatencyJobStatus, error) {
	_, cfg, err := s.getSubscriptionTarget(id)
	if err != nil {
		return SubscriptionLatencyJobStatus{}, err
	}
	if cfg.LatencyConcurrency <= 0 {
		return SubscriptionLatencyJobStatus{}, errors.New("latency_concurrency must be greater than 0")
	}

	var nodes []model.SubscriptionNode
	if err := s.DB.Where("target_id = ?", id).Find(&nodes).Error; err != nil {
		return SubscriptionLatencyJobStatus{}, err
	}

	jobID := randomJobID()
	now := time.Now()
	job := &subscriptionLatencyJob{
		status: SubscriptionLatencyJobStatus{
			JobID:     jobID,
			TargetID:  id,
			Status:    "running",
			Total:     len(nodes),
			Done:      0,
			Success:   0,
			Failed:    0,
			StartedAt: now,
			UpdatedAt: now,
		},
		subscribers: map[chan SubscriptionLatencyJobEvent]struct{}{},
	}

	s.latencyJobsMu.Lock()
	if s.latencyJobs == nil {
		s.latencyJobs = map[string]*subscriptionLatencyJob{}
	}
	s.latencyJobs[jobID] = job
	s.latencyJobsMu.Unlock()

	go s.runSubscriptionLatencyJob(job, id, nodes, cfg)
	return job.snapshot(), nil
}

func (s *TargetService) runSubscriptionLatencyJob(job *subscriptionLatencyJob, targetID uint, nodes []model.SubscriptionNode, cfg *subscriptionConfig) {
	if len(nodes) == 0 {
		now := time.Now()
		job.update(func(st *SubscriptionLatencyJobStatus) {
			st.Status = "done"
			st.FinishedAt = &now
			st.UpdatedAt = now
		}, "done", nil)
		job.closeAll()
		s.scheduleSubscriptionLatencyJobCleanup(job.snapshot().JobID)
		return
	}

	timeoutMS := cfg.LatencyTimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 1200
	}
	probeCount := cfg.LatencyProbeCount
	if probeCount <= 0 {
		probeCount = 3
	}
	concurrency := cfg.LatencyConcurrency
	if concurrency <= 0 {
		concurrency = 1
	}

	jobs := make(chan model.SubscriptionNode)
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for node := range jobs {
				lat, errMsg, err := s.probeAndPersistSubscriptionNode(targetID, node, timeoutMS, probeCount, cfg)
				if err != nil {
					errMsg = err.Error()
				}
				nodeEvent := &SubscriptionLatencyJobNode{NodeUID: node.NodeUID, LatencyMS: lat, ErrorMsg: errMsg, CheckedAt: time.Now()}
				job.update(func(st *SubscriptionLatencyJobStatus) {
					st.Done++
					if errMsg == "" {
						st.Success++
					} else {
						st.Failed++
					}
					st.UpdatedAt = time.Now()
				}, "node_result", nodeEvent)
				job.update(func(st *SubscriptionLatencyJobStatus) {
					st.UpdatedAt = time.Now()
				}, "progress", nil)
			}
		}()
	}

	for _, n := range nodes {
		jobs <- n
	}
	close(jobs)
	wg.Wait()

	now := time.Now()
	job.update(func(st *SubscriptionLatencyJobStatus) {
		st.Status = "done"
		st.FinishedAt = &now
		st.UpdatedAt = now
	}, "done", nil)
	job.closeAll()
	s.scheduleSubscriptionLatencyJobCleanup(job.snapshot().JobID)
}

func (s *TargetService) scheduleSubscriptionLatencyJobCleanup(jobID string) {
	if jobID == "" {
		return
	}
	go func() {
		time.Sleep(subscriptionLatencyJobRetention)
		s.latencyJobsMu.Lock()
		delete(s.latencyJobs, jobID)
		s.latencyJobsMu.Unlock()
	}()
}

func (s *TargetService) SubscriptionLatencyJobStatus(id uint, jobID string) (SubscriptionLatencyJobStatus, error) {
	s.latencyJobsMu.RLock()
	job, ok := s.latencyJobs[jobID]
	s.latencyJobsMu.RUnlock()
	if !ok {
		return SubscriptionLatencyJobStatus{}, errors.New("latency job not found")
	}
	snap := job.snapshot()
	if snap.TargetID != id {
		return SubscriptionLatencyJobStatus{}, errors.New("latency job not found")
	}
	return snap, nil
}

func (s *TargetService) SubscribeSubscriptionLatencyJob(id uint, jobID string) (SubscriptionLatencyJobStatus, chan SubscriptionLatencyJobEvent, func(), error) {
	s.latencyJobsMu.RLock()
	job, ok := s.latencyJobs[jobID]
	s.latencyJobsMu.RUnlock()
	if !ok {
		return SubscriptionLatencyJobStatus{}, nil, nil, errors.New("latency job not found")
	}
	snap := job.snapshot()
	if snap.TargetID != id {
		return SubscriptionLatencyJobStatus{}, nil, nil, errors.New("latency job not found")
	}
	ch := job.subscribe()
	cancel := func() { job.unsubscribe(ch) }
	return snap, ch, cancel, nil
}

func randomJobID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "job-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	return "job-" + hex.EncodeToString(b)
}
