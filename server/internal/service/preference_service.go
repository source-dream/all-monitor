package service

import (
	"all-monitor/server/internal/model"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

type PreferenceDefaults struct {
	Scope     string         `json:"scope"`
	Version   int            `json:"version"`
	Values    map[string]any `json:"values"`
	UpdatedAt string         `json:"updated_at"`
}

type PreferenceService struct {
	DB *gorm.DB
}

func (s *PreferenceService) GetDefaults(uid uint, scope string) (*PreferenceDefaults, error) {
	if uid == 0 {
		return nil, errors.New("uid is required")
	}
	key := preferenceSettingKey(uid, scope)
	var setting model.SystemSetting
	err := s.DB.Where("key = ?", key).First(&setting).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out PreferenceDefaults
	if unmarshalErr := json.Unmarshal([]byte(setting.Value), &out); unmarshalErr != nil {
		return nil, unmarshalErr
	}
	if out.Scope == "" {
		out.Scope = scope
	}
	if out.Version <= 0 {
		out.Version = 1
	}
	if out.Values == nil {
		out.Values = map[string]any{}
	}
	if out.UpdatedAt == "" {
		out.UpdatedAt = setting.UpdatedAt.Format(time.RFC3339)
	}
	return &out, nil
}

func (s *PreferenceService) SetDefaults(uid uint, scope string, values map[string]any) (*PreferenceDefaults, error) {
	if uid == 0 {
		return nil, errors.New("uid is required")
	}
	now := time.Now().Format(time.RFC3339)
	payload := PreferenceDefaults{
		Scope:     scope,
		Version:   1,
		Values:    values,
		UpdatedAt: now,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	key := preferenceSettingKey(uid, scope)
	var setting model.SystemSetting
	queryErr := s.DB.Where("key = ?", key).First(&setting).Error
	if errors.Is(queryErr, gorm.ErrRecordNotFound) {
		createErr := s.DB.Create(&model.SystemSetting{Key: key, Value: string(raw)}).Error
		if createErr != nil {
			return nil, createErr
		}
		return &payload, nil
	}
	if queryErr != nil {
		return nil, queryErr
	}
	if updateErr := s.DB.Model(&model.SystemSetting{}).Where("id = ?", setting.ID).Update("value", string(raw)).Error; updateErr != nil {
		return nil, updateErr
	}
	return &payload, nil
}

func preferenceSettingKey(uid uint, scope string) string {
	return fmt.Sprintf("pref:%d:%s", uid, scope)
}
