import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Badge, Typography, Progress, Tag, Space } from 'antd';
import { TrophyOutlined, CheckCircleOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  reward: {
    affection: number;
    happiness: number;
    badge: string;
  };
  unlocked: boolean;
  unlockedAt?: string;
  order: number;
}

interface AchievementPanelProps {
  open: boolean;
  onClose: () => void;
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_feed', title: '第一餐', description: '给宠物喂食', icon: '🍖', reward: { affection: 10, happiness: 5, badge: '🍜' }, unlocked: false, order: 1 },
  { id: 'first_play', title: '第一次玩耍', description: '和宠物玩耍', icon: '🎮', reward: { affection: 10, happiness: 10, badge: '🎾' }, unlocked: false, order: 2 },
  { id: 'first_talk', title: '第一次对话', description: '和宠物说第一句话', icon: '💬', reward: { affection: 15, happiness: 5, badge: '🗣️' }, unlocked: false, order: 3 },
  { id: 'stage_baby', title: '成长为幼崽', description: '宠物成长为幼崽阶段', icon: '👶', reward: { affection: 20, happiness: 20, badge: '👶' }, unlocked: false, order: 10 },
  { id: 'stage_child', title: '成长为孩童', description: '宠物成长为孩童阶段', icon: '🧒', reward: { affection: 30, happiness: 30, badge: '🧒' }, unlocked: false, order: 20 },
  { id: 'stage_adult', title: '成长为成年', description: '宠物成长为成年阶段', icon: '🐱', reward: { affection: 50, happiness: 50, badge: '👑' }, unlocked: false, order: 30 },
  { id: '100_affection', title: '亲密无间', description: '好感度达到100', icon: '❤️', reward: { affection: 100, happiness: 100, badge: '💖' }, unlocked: false, order: 40 },
  { id: '7_days', title: '一周陪伴', description: '连续陪伴7天', icon: '📅', reward: { affection: 30, happiness: 30, badge: '📅' }, unlocked: false, order: 50 },
  { id: '30_days', title: '一个月陪伴', description: '连续陪伴30天', icon: '🎁', reward: { affection: 50, happiness: 50, badge: '🎉' }, unlocked: false, order: 60 },
  { id: 'health_master', title: '健康大师', description: '保持健康100天', icon: '🏥', reward: { affection: 20, happiness: 20, badge: '🛡️' }, unlocked: false, order: 70 },
  { id: 'happy_pet', title: '快乐宠物', description: '保持快乐100天', icon: '😄', reward: { affection: 20, happiness: 20, badge: '🎈' }, unlocked: false, order: 80 },
  { id: 'total_100_talk', title: '聊天达人', description: '总共聊天100次', icon: '📝', reward: { affection: 30, happiness: 30, badge: '🎤' }, unlocked: false, order: 90 },
];

const AchievementPanel: React.FC<AchievementPanelProps> = ({ open }) => {
  const [unlockProgress, setUnlockProgress] = useState({ current: 0, total: 0, percentage: 0 });

  useEffect(() => {
    if (open) {
      loadAchievements();
    }
  }, [open]);

  const loadAchievements = () => {
    // 模拟加载
    const saved = localStorage.getItem('achievement_data');
    if (saved) {
      const data = JSON.parse(saved);
      setUnlockProgress(data.progress || { current: 0, total: 0, percentage: 0 });
    } else {
      // 初始状态
      setUnlockProgress({ current: 0, total: 12, percentage: 0 });
      localStorage.setItem('achievement_data', JSON.stringify({
        unlocked: [],
        progress: { current: 0, total: 12, percentage: 0 },
      }));
    }
  };

  return (
    <Card title={
      <Space>
        <TrophyOutlined style={{ color: '#f1c40f' }} />
        <span>成就系统</span>
        <Badge count={unlockProgress.percentage} overflowCount={100} color="gold" />
      </Space>
    } extra={<Text type="secondary">{unlockProgress.current}/{unlockProgress.total} 个成就</Text>}>
      <Progress percent={unlockProgress.percentage} status="active" strokeColor={{ from: '#f1c40f', to: '#e67e22' }} />

      <div style={{ marginTop: 20 }}>
        <Title level={5}>成就列表</Title>
        <Row gutter={16}>
          {ACHIEVEMENTS.sort((a, b) => a.order - b.order).map((achievement) => (
            <Col span={8} key={achievement.id}>
              <Card
                size="small"
                hoverable
                style={{ opacity: achievement.unlocked ? 1 : 0.6 }}
                title={
                  <Space>
                    <span style={{ fontSize: 20 }}>{achievement.icon}</span>
                    <span>{achievement.title}</span>
                    {achievement.unlocked && <CheckCircleOutlined style={{ color: '#52c41a' }} />}
                  </Space>
                }
              >
                <Text type="secondary" style={{ fontSize: 12 }}>{achievement.description}</Text>
                {achievement.unlocked ? (
                  <Tag color="gold" style={{ marginTop: 8 }}>
                    解锁！🎉
                  </Tag>
                ) : (
                  <Tag color="default" style={{ marginTop: 8 }}>
                    未解锁
                  </Tag>
                )}
                {achievement.unlocked && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#e67e22' }}>
                    奖励: +{achievement.reward.affection}好感 +{achievement.reward.happiness}快乐
                  </div>
                )}
              </Card>
            </Col>
          ))}
        </Row>
      </div>
    </Card>
  );
};

export default AchievementPanel;
