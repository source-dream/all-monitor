package service

import (
	"errors"
	"time"

	"all-monitor/server/internal/model"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

type AuthService struct {
	DB        *gorm.DB
	JWTSecret string
}

func (s *AuthService) IsInitialized() (bool, error) {
	var setting model.SystemSetting
	err := s.DB.Where("key = ?", "init_done").First(&setting).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return setting.Value == "true", nil
}

func (s *AuthService) BootstrapAdmin(username, password string) error {
	initialized, err := s.IsInitialized()
	if err != nil {
		return err
	}
	if initialized {
		return errors.New("system already initialized")
	}

	// 首次初始化时，统一在事务内创建管理员并写入初始化标记，避免并发重复初始化。
	return s.DB.Transaction(func(tx *gorm.DB) error {
		hash, hashErr := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if hashErr != nil {
			return hashErr
		}

		if err := tx.Create(&model.User{Username: username, PasswordHash: string(hash)}).Error; err != nil {
			return err
		}

		return tx.Create(&model.SystemSetting{Key: "init_done", Value: "true"}).Error
	})
}

func (s *AuthService) Login(username, password string) (string, error) {
	var user model.User
	if err := s.DB.Where("username = ?", username).First(&user).Error; err != nil {
		return "", errors.New("invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", errors.New("invalid credentials")
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"uid": user.ID,
		"usr": user.Username,
		"exp": time.Now().Add(12 * time.Hour).Unix(),
	})

	return token.SignedString([]byte(s.JWTSecret))
}
