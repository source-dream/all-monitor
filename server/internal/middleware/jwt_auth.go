package middleware

import (
	"all-monitor/server/pkg/response"
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

		c.Next()
	}
}
