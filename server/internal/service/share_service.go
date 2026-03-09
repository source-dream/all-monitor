package service

import (
	"all-monitor/server/internal/model"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

type ShareTaskUpdate struct {
	Enabled   *bool
	Name      *string
	Password  *string
	ExpiresAt *time.Time
}

func normalizeShareTargetIDs(ids []uint) []uint {
	uniq := make([]uint, 0, len(ids))
	seen := map[uint]struct{}{}
	for _, id := range ids {
		if id == 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		uniq = append(uniq, id)
	}
	return uniq
}

func parseShareTargetIDs(raw string) ([]uint, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("share target ids missing")
	}
	var ids []uint
	if err := json.Unmarshal([]byte(trimmed), &ids); err != nil {
		return nil, err
	}
	ids = normalizeShareTargetIDs(ids)
	if len(ids) == 0 {
		return nil, errors.New("share target ids empty")
	}
	return ids, nil
}

func generateShareToken() (string, error) {
	buf := make([]byte, 30)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (s *TargetService) CreateShareTask(createdBy uint, name string, targetIDs []uint, password string, expiresAt time.Time) (*model.ShareTask, error) {
	name = strings.TrimSpace(name)
	password = strings.TrimSpace(password)
	targetIDs = normalizeShareTargetIDs(targetIDs)
	if len(targetIDs) == 0 {
		return nil, errors.New("请选择至少一个目标")
	}
	if expiresAt.Before(time.Now().Add(1 * time.Minute)) {
		return nil, errors.New("过期时间必须晚于当前时间")
	}

	if name == "" {
		name = fmt.Sprintf("分享任务 %s", time.Now().Format("2006-01-02 15:04"))
	}

	var found int64
	if err := s.DB.Model(&model.MonitorTarget{}).Where("id IN ?", targetIDs).Count(&found).Error; err != nil {
		return nil, err
	}
	if int(found) != len(targetIDs) {
		return nil, errors.New("包含不存在的目标")
	}

	passwordHash := ""
	if password != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		passwordHash = string(hash)
	}
	idsRaw, _ := json.Marshal(targetIDs)

	token, err := generateShareToken()
	if err != nil {
		return nil, err
	}

	share := &model.ShareTask{
		Name:          name,
		ShareToken:    token,
		TargetIDsJSON: string(idsRaw),
		PasswordHash:  passwordHash,
		ExpiresAt:     expiresAt,
		Enabled:       true,
		CreatedBy:     createdBy,
	}
	if err := s.DB.Create(share).Error; err != nil {
		return nil, err
	}
	return share, nil
}

func (s *TargetService) ListShareTasks(createdBy uint) ([]map[string]any, error) {
	var shares []model.ShareTask
	if err := s.DB.Where("created_by = ?", createdBy).Order("id desc").Find(&shares).Error; err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(shares))
	for _, row := range shares {
		ids, err := parseShareTargetIDs(row.TargetIDsJSON)
		if err != nil {
			ids = nil
		}
		out = append(out, map[string]any{
			"id":             row.ID,
			"name":           row.Name,
			"share_token":    row.ShareToken,
			"target_count":   len(ids),
			"expires_at":     row.ExpiresAt,
			"enabled":        row.Enabled,
			"last_access_at": row.LastAccessAt,
			"created_at":     row.CreatedAt,
			"updated_at":     row.UpdatedAt,
		})
	}
	return out, nil
}

func (s *TargetService) SetShareTaskEnabled(createdBy uint, id uint, enabled bool) error {
	res := s.DB.Model(&model.ShareTask{}).
		Where("id = ? AND created_by = ?", id, createdBy).
		Updates(map[string]any{"enabled": enabled})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errors.New("share task not found")
	}
	return nil
}

func (s *TargetService) UpdateShareTask(createdBy uint, id uint, req ShareTaskUpdate) error {
	var share model.ShareTask
	if err := s.DB.Where("id = ? AND created_by = ?", id, createdBy).First(&share).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return errors.New("share task not found")
		}
		return err
	}

	updates := map[string]any{}
	if req.Enabled != nil {
		updates["enabled"] = *req.Enabled
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return errors.New("分享名称不能为空")
		}
		updates["name"] = name
	}
	if req.Password != nil {
		password := strings.TrimSpace(*req.Password)
		if password == "" {
			return errors.New("分享密码不能为空")
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		updates["password_hash"] = string(hash)
	}
	if req.ExpiresAt != nil {
		if req.ExpiresAt.Before(time.Now().Add(1 * time.Minute)) {
			return errors.New("过期时间必须晚于当前时间")
		}
		updates["expires_at"] = *req.ExpiresAt
	}

	if len(updates) == 0 {
		return errors.New("no updates")
	}

	res := s.DB.Model(&model.ShareTask{}).Where("id = ? AND created_by = ?", id, createdBy).Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errors.New("share task not found")
	}
	return nil
}

func (s *TargetService) DeleteShareTask(createdBy uint, id uint) error {
	res := s.DB.Where("id = ? AND created_by = ?", id, createdBy).Delete(&model.ShareTask{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return errors.New("share task not found")
	}
	return nil
}

func (s *TargetService) findShareByToken(token string) (*model.ShareTask, error) {
	var share model.ShareTask
	if err := s.DB.Where("share_token = ?", strings.TrimSpace(token)).First(&share).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errors.New("分享任务不存在")
		}
		return nil, err
	}
	if !share.Enabled {
		return nil, errors.New("分享任务已禁用")
	}
	if time.Now().After(share.ExpiresAt) {
		return nil, errors.New("分享任务已过期")
	}
	return &share, nil
}

func (s *TargetService) VerifyShareAccess(shareToken string, password string) (*model.ShareTask, error) {
	share, err := s.findShareByToken(shareToken)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(share.PasswordHash) != "" && bcrypt.CompareHashAndPassword([]byte(share.PasswordHash), []byte(password)) != nil {
		return nil, errors.New("分享密码错误")
	}
	now := time.Now()
	_ = s.DB.Model(&model.ShareTask{}).Where("id = ?", share.ID).Update("last_access_at", now).Error
	share.LastAccessAt = &now
	return share, nil
}

func (s *TargetService) ShareDashboard(shareToken string) (map[string]any, error) {
	share, err := s.findShareByToken(shareToken)
	if err != nil {
		return nil, err
	}
	targetIDs, err := parseShareTargetIDs(share.TargetIDsJSON)
	if err != nil {
		return nil, errors.New("分享目标配置异常")
	}

	var targets []model.MonitorTarget
	if err := s.DB.Where("id IN ?", targetIDs).Find(&targets).Error; err != nil {
		return nil, err
	}
	targetMap := make(map[uint]model.MonitorTarget, len(targets))
	for _, row := range targets {
		row.ConfigJSON = ""
		targetMap[row.ID] = row
	}
	orderedTargets := make([]model.MonitorTarget, 0, len(targetIDs))
	for _, id := range targetIDs {
		if row, ok := targetMap[id]; ok {
			orderedTargets = append(orderedTargets, row)
		}
	}

	resultMap := map[string][]model.CheckResult{}
	trackingMap := map[string]map[string]any{}
	subscriptionMap := map[string]map[string]any{}
	financeMap := map[string]map[string]any{}
	since := time.Now().Add(-24 * time.Hour)

	for _, target := range orderedTargets {
		key := strconv.FormatUint(uint64(target.ID), 10)
		var results []model.CheckResult
		if queryErr := s.DB.
			Where("target_id = ? AND checked_at >= ?", target.ID, since).
			Order("checked_at desc").
			Limit(2000).
			Find(&results).Error; queryErr != nil {
			return nil, queryErr
		}
		resultMap[key] = results

		if target.Type == "tracking" {
			summary, sumErr := s.TrackingSummary(target.ID, since)
			if sumErr != nil {
				return nil, sumErr
			}
			trackingMap[key] = summary
		}
		if target.Type == "subscription" || target.Type == "node_group" {
			summary, sumErr := s.SubscriptionSummary(target.ID)
			if sumErr != nil {
				return nil, sumErr
			}
			subscriptionMap[key] = summary
		}
		if target.Type == "ai" || target.Type == "api" {
			summary, sumErr := s.FinanceSummary(target.ID)
			if sumErr != nil {
				return nil, sumErr
			}
			financeMap[key] = summary
		}
	}

	return map[string]any{
		"share": map[string]any{
			"id":         share.ID,
			"name":       share.Name,
			"expires_at": share.ExpiresAt,
			"enabled":    share.Enabled,
		},
		"targets":          orderedTargets,
		"result_map":       resultMap,
		"tracking_map":     trackingMap,
		"subscription_map": subscriptionMap,
		"finance_map":      financeMap,
		"server_time":      time.Now(),
	}, nil
}
