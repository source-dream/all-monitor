package scheduler

import (
	"all-monitor/server/internal/checker"
	"all-monitor/server/internal/model"
	"context"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"
)

type Scheduler struct {
	DB          *gorm.DB
	Concurrency int
}

func (s *Scheduler) Start(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.runOnce(ctx)
		}
	}
}

func (s *Scheduler) runOnce(ctx context.Context) {
	var targets []model.MonitorTarget
	if err := s.DB.Where("enabled = ?", true).Find(&targets).Error; err != nil {
		log.Printf("load targets failed: %v", err)
		return
	}

	limit := s.Concurrency
	if limit <= 0 {
		limit = 8
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup

	for _, target := range targets {
		target := target
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if target.Type == "tracking" {
				return
			}

			ck, err := checker.SelectChecker(target.Type)
			if err != nil {
				return
			}

			// 这里每次只做一次健康检查；后续可基于 interval_sec 做更精细调度。
			result, snapshot, checkErr := ck.Check(ctx, target)
			if checkErr != nil {
				result = model.CheckResult{
					TargetID:  target.ID,
					Success:   false,
					LatencyMS: 0,
					ErrorMsg:  checkErr.Error(),
					CheckedAt: time.Now(),
				}
			}
			if err := s.DB.Create(&result).Error; err != nil {
				log.Printf("save result failed: %v", err)
			}
			if snapshot != nil {
				if err := s.DB.Create(snapshot).Error; err != nil {
					log.Printf("save finance snapshot failed: %v", err)
				}
			}
		}()
	}

	wg.Wait()
}
