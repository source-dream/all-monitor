package middleware

import (
	"all-monitor/server/pkg/response"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

func JWTAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		tokenString := ""
		if auth != "" && strings.HasPrefix(auth, "Bearer ") {
			tokenString = strings.TrimPrefix(auth, "Bearer ")
		} else {
			tokenString = c.Query("access_token")
		}
		if tokenString == "" {
			response.Err(c, 401, 40101, "missing bearer token")
			c.Abort()
			return
		}

		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
			return []byte(secret), nil
		})
		if err != nil || !token.Valid {
			response.Err(c, 401, 40102, "invalid token")
			c.Abort()
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			response.Err(c, 401, 40102, "invalid token claims")
			c.Abort()
			return
		}
		uidRaw, ok := claims["uid"]
		if !ok {
			response.Err(c, 401, 40102, "missing uid in token")
			c.Abort()
			return
		}
		uid, convErr := parseUID(uidRaw)
		if convErr != nil {
			response.Err(c, 401, 40102, "invalid uid in token")
			c.Abort()
			return
		}
		c.Set("uid", uid)
		if usrRaw, ok := claims["usr"]; ok {
			if usr, ok := usrRaw.(string); ok {
				c.Set("usr", usr)
			}
		}

		c.Next()
	}
}

func parseUID(raw any) (uint, error) {
	switch v := raw.(type) {
	case float64:
		if v <= 0 {
			return 0, fmt.Errorf("uid must be positive")
		}
		return uint(v), nil
	case int:
		if v <= 0 {
			return 0, fmt.Errorf("uid must be positive")
		}
		return uint(v), nil
	case int64:
		if v <= 0 {
			return 0, fmt.Errorf("uid must be positive")
		}
		return uint(v), nil
	default:
		return 0, fmt.Errorf("unsupported uid type")
	}
}
